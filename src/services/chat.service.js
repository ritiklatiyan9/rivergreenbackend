import pool from '../config/db.js';
import ChatConversation from '../models/ChatConversation.model.js';
import ChatMessage from '../models/ChatMessage.model.js';
import ChatPermission from '../models/ChatPermission.model.js';
import { uploadSingle } from '../utils/upload.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_GROUP_PARTICIPANTS = 100;

export class ChatScopeError extends Error {
  constructor(message, statusCode = 403) {
    super(message);
    this.name = 'ChatScopeError';
    this.statusCode = statusCode;
  }
}

const normalizeParticipantIds = (participantIds) => {
  const normalized = Array.from(new Set(
    (Array.isArray(participantIds) ? participantIds : [])
      .filter(Boolean)
      .map((id) => String(id).trim())
  ));

  if (normalized.length > MAX_GROUP_PARTICIPANTS) {
    throw new ChatScopeError(`A group can contain at most ${MAX_GROUP_PARTICIPANTS} participants.`, 400);
  }
  if (normalized.some((id) => !UUID_PATTERN.test(id))) {
    throw new ChatScopeError('One or more participant IDs are invalid.', 400);
  }
  return normalized;
};

export const ensureChatParticipantsInSite = async ({
  db = pool,
  siteId,
  participantIds,
}) => {
  if (!siteId) throw new ChatScopeError('Select an active site before starting a chat.', 409);
  const normalized = normalizeParticipantIds(participantIds);
  if (normalized.length === 0) return [];

  const result = await db.query(
    `SELECT u.id
     FROM users u
     WHERE u.id = ANY($2::uuid[])
       AND u.is_active = TRUE
       AND (
         u.site_id = $1
         OR EXISTS (
           SELECT 1 FROM user_site_access usa
           WHERE usa.user_id = u.id AND usa.site_id = $1
         )
         OR EXISTS (
           SELECT 1 FROM supervisor_site_access ssa
           WHERE ssa.supervisor_id = u.id AND ssa.site_id = $1
         )
       )`,
    [siteId, normalized]
  );

  const allowedIds = new Set(result.rows.map((row) => String(row.id)));
  if (normalized.some((id) => !allowedIds.has(id))) {
    throw new ChatScopeError('One or more participants are unavailable in the active site.');
  }
  return normalized;
};

export const listChatUsersForSite = async ({ db = pool, currentUserId, siteId }) => {
  if (!siteId) throw new ChatScopeError('Select an active site before opening chat.', 409);
  const query = `
    SELECT u.id, u.name, u.email, u.role, u.profile_photo, u.is_active
    FROM users u
    WHERE u.id != $1
      AND u.is_active = TRUE
      AND (
        u.site_id = $2
        OR EXISTS (
          SELECT 1 FROM user_site_access usa
          WHERE usa.user_id = u.id AND usa.site_id = $2
        )
        OR EXISTS (
          SELECT 1 FROM supervisor_site_access ssa
          WHERE ssa.supervisor_id = u.id AND ssa.site_id = $2
        )
      )
    ORDER BY u.name ASC
    LIMIT 500
  `;
  const result = await db.query(query, [currentUserId, siteId]);
  return result.rows;
};

class ChatService {
  async assertConversationAccess(conversationId, userId, siteId) {
    const allowed = await ChatConversation.isParticipantForSite(conversationId, userId, siteId, pool);
    if (!allowed) throw new ChatScopeError('Conversation is unavailable in the active site.');
  }

  /**
   * Get or create a direct conversation between two users
   */
  async getOrCreateConversation(currentUserId, otherUserId, siteId) {
    const [targetUserId] = await ensureChatParticipantsInSite({ siteId, participantIds: [otherUserId] });
    // Check if conversation already exists
    let conversation = await ChatConversation.findDirectConversation(currentUserId, targetUserId, pool);
    if (conversation) return conversation;

    // Create new conversation
    conversation = await ChatConversation.createWithParticipants(
      currentUserId,
      [currentUserId, targetUserId],
      pool
    );
    return conversation;
  }

  /**
   * Create a group conversation
   */
  async createGroupConversation(currentUserId, groupName, participantIds = [], siteId) {
    const normalized = normalizeParticipantIds(participantIds);

    const withoutSelf = normalized.filter((id) => String(id) !== String(currentUserId));
    if (withoutSelf.length < 1) {
      throw new Error('Please select at least one user for group chat');
    }

    await ensureChatParticipantsInSite({ siteId, participantIds: withoutSelf });

    const participants = [currentUserId, ...withoutSelf];
    const safeGroupName = String(groupName || '').trim().slice(0, 120) || 'New Group';

    return ChatConversation.createWithParticipants(
      currentUserId,
      participants,
      pool,
      { isGroup: true, groupName: safeGroupName }
    );
  }

  /**
   * Get all conversations for a user
   */
  async getUserConversations(userId, siteId) {
    if (!siteId) throw new ChatScopeError('Select an active site before opening chat.', 409);
    return ChatConversation.getUserConversations(userId, siteId, pool);
  }

  /**
   * Get paginated messages for a conversation
   */
  async getMessages(conversationId, userId, siteId, { limit = 30, before = null } = {}) {
    await this.assertConversationAccess(conversationId, userId, siteId);

    return ChatMessage.getMessages(conversationId, { limit, before }, pool);
  }

  /**
   * Send a text message
   */
  async sendMessage(conversationId, senderId, siteId, messageText) {
    await this.assertConversationAccess(conversationId, senderId, siteId);

    const message = await ChatMessage.createMessage({
      conversation_id: conversationId,
      sender_id: senderId,
      message_text: messageText,
      message_type: 'text',
    }, pool);

    return ChatMessage.getMessageWithSender(message.id, pool);
  }

  /**
   * Send a document/file message
   */
  async sendFileMessage(conversationId, senderId, siteId, file, messageText) {
    await this.assertConversationAccess(conversationId, senderId, siteId);

    // Upload to S3
    const result = await uploadSingle(file, 's3');

    const message = await ChatMessage.createMessage({
      conversation_id: conversationId,
      sender_id: senderId,
      message_text: messageText || null,
      message_type: 'document',
      file_url: result.secure_url,
      file_name: file.originalname,
    }, pool);

    return ChatMessage.getMessageWithSender(message.id, pool);
  }

  /**
   * Edit a message
   */
  async editMessage(messageId, senderId, siteId, newText, userRole) {
    // Check permission
    const permission = await ChatPermission.getByRole(userRole, pool);
    if (!permission?.can_edit_message) throw new Error('You do not have permission to edit messages');

    const existing = await pool.query(
      'SELECT conversation_id FROM chat_messages WHERE id = $1 AND sender_id = $2 LIMIT 1',
      [messageId, senderId]
    );
    if (!existing.rows[0]) throw new Error('Message not found or you are not the sender');
    await this.assertConversationAccess(existing.rows[0].conversation_id, senderId, siteId);

    const message = await ChatMessage.editMessage(messageId, senderId, newText, pool);
    if (!message) throw new Error('Message not found or you are not the sender');

    return ChatMessage.getMessageWithSender(message.id, pool);
  }

  /**
   * Delete a message (soft delete)
   */
  async deleteMessage(messageId, senderId, siteId, userRole) {
    const permission = await ChatPermission.getByRole(userRole, pool);
    if (!permission?.can_delete_message) throw new Error('You do not have permission to delete messages');

    const existing = await pool.query(
      'SELECT conversation_id FROM chat_messages WHERE id = $1 AND sender_id = $2 LIMIT 1',
      [messageId, senderId]
    );
    if (!existing.rows[0]) throw new Error('Message not found or you are not the sender');
    await this.assertConversationAccess(existing.rows[0].conversation_id, senderId, siteId);

    const message = await ChatMessage.softDelete(messageId, senderId, pool);
    if (!message) throw new Error('Message not found or you are not the sender');

    return message;
  }

  /**
   * Get all chat permissions (admin only)
   */
  async getAllPermissions() {
    return ChatPermission.getAllPermissions(pool);
  }

  /**
   * Update permission for a role (admin only)
   */
  async updatePermission(roleName, data) {
    return ChatPermission.updatePermission(roleName, data, pool);
  }

  /**
   * Get permission for the current user's role
   */
  async getUserPermission(role) {
    return ChatPermission.getByRole(role, pool);
  }

  /**
   * Get all users for chat (for starting new conversation)
   */
  async getChatUsers(currentUserId, siteId) {
    return listChatUsersForSite({ currentUserId, siteId });
  }

  /**
   * Get participants for a conversation
   */
  async getConversationParticipants(conversationId, siteId, requesterId) {
    await this.assertConversationAccess(conversationId, requesterId, siteId);
    const query = `
      SELECT u.id, u.name, u.email, u.role, u.profile_photo
      FROM chat_participants cp
      JOIN users u ON u.id = cp.user_id
      WHERE cp.conversation_id = $1
        AND (
          u.id = $3
          OR u.site_id = $2
          OR EXISTS (
            SELECT 1 FROM user_site_access usa
            WHERE usa.user_id = u.id AND usa.site_id = $2
          )
          OR EXISTS (
            SELECT 1 FROM supervisor_site_access ssa
            WHERE ssa.supervisor_id = u.id AND ssa.site_id = $2
          )
        )
    `;
    const result = await pool.query(query, [conversationId, siteId, requesterId]);
    return result.rows;
  }

  /**
   * Delete a conversation.
   * - Direct chat: any participant can delete the full chat thread.
   * - Group chat: only creator or ADMIN can delete the group.
   */
  async deleteConversation(conversationId, currentUserId, currentUserRole, siteId) {
    await this.assertConversationAccess(conversationId, currentUserId, siteId);
    const convRes = await pool.query(
      'SELECT id, created_by, COALESCE(is_group, false) AS is_group, group_name FROM chat_conversations WHERE id = $1',
      [conversationId]
    );
    const conversation = convRes.rows[0];
    if (!conversation) throw new Error('Conversation not found');

    if (conversation.is_group) {
      const canDeleteGroup = String(conversation.created_by) === String(currentUserId) || currentUserRole === 'ADMIN';
      if (!canDeleteGroup) {
        throw new Error('Only group creator or admin can delete this group');
      }
      await pool.query('DELETE FROM chat_conversations WHERE id = $1', [conversationId]);
      return { deleted: true, is_group: true, group_name: conversation.group_name || 'Group Chat' };
    }

    await pool.query('DELETE FROM chat_conversations WHERE id = $1', [conversationId]);
    return { deleted: true, is_group: false };
  }
}

export default new ChatService();
