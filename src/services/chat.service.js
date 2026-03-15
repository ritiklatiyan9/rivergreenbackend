import pool from '../config/db.js';
import ChatConversation from '../models/ChatConversation.model.js';
import ChatMessage from '../models/ChatMessage.model.js';
import ChatPermission from '../models/ChatPermission.model.js';
import { uploadSingle } from '../utils/upload.js';
import { cleanupFile } from '../middlewares/multer.middleware.js';

class ChatService {
  /**
   * Get or create a direct conversation between two users
   */
  async getOrCreateConversation(currentUserId, otherUserId) {
    // Check if conversation already exists
    let conversation = await ChatConversation.findDirectConversation(currentUserId, otherUserId, pool);
    if (conversation) return conversation;

    // Create new conversation
    conversation = await ChatConversation.createWithParticipants(
      currentUserId,
      [currentUserId, otherUserId],
      pool
    );
    return conversation;
  }

  /**
   * Create a group conversation
   */
  async createGroupConversation(currentUserId, groupName, participantIds = []) {
    const normalized = Array.from(new Set(
      (participantIds || []).filter(Boolean).map((id) => String(id).trim())
    ));

    const withoutSelf = normalized.filter((id) => String(id) !== String(currentUserId));
    if (withoutSelf.length < 1) {
      throw new Error('Please select at least one user for group chat');
    }

    const participants = [currentUserId, ...withoutSelf];

    return ChatConversation.createWithParticipants(
      currentUserId,
      participants,
      pool,
      { isGroup: true, groupName: (groupName || '').trim() || 'New Group' }
    );
  }

  /**
   * Get all conversations for a user
   */
  async getUserConversations(userId) {
    return ChatConversation.getUserConversations(userId, pool);
  }

  /**
   * Get paginated messages for a conversation
   */
  async getMessages(conversationId, userId, { limit = 30, before = null } = {}) {
    // Verify participation
    const isParticipant = await ChatConversation.isParticipant(conversationId, userId, pool);
    if (!isParticipant) throw new Error('Not a participant of this conversation');

    return ChatMessage.getMessages(conversationId, { limit, before }, pool);
  }

  /**
   * Send a text message
   */
  async sendMessage(conversationId, senderId, messageText) {
    const isParticipant = await ChatConversation.isParticipant(conversationId, senderId, pool);
    if (!isParticipant) throw new Error('Not a participant of this conversation');

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
  async sendFileMessage(conversationId, senderId, file, messageText) {
    const isParticipant = await ChatConversation.isParticipant(conversationId, senderId, pool);
    if (!isParticipant) throw new Error('Not a participant of this conversation');

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
  async editMessage(messageId, senderId, newText, userRole) {
    // Check permission
    const permission = await ChatPermission.getByRole(userRole, pool);
    if (!permission?.can_edit_message) throw new Error('You do not have permission to edit messages');

    const message = await ChatMessage.editMessage(messageId, senderId, newText, pool);
    if (!message) throw new Error('Message not found or you are not the sender');

    return ChatMessage.getMessageWithSender(message.id, pool);
  }

  /**
   * Delete a message (soft delete)
   */
  async deleteMessage(messageId, senderId, userRole) {
    const permission = await ChatPermission.getByRole(userRole, pool);
    if (!permission?.can_delete_message) throw new Error('You do not have permission to delete messages');

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
  async getChatUsers(currentUserId) {
    const query = `
      SELECT id, name, email, role, profile_photo, is_active
      FROM users
      WHERE id != $1 AND is_active = true
      ORDER BY name ASC
    `;
    const result = await pool.query(query, [currentUserId]);
    return result.rows;
  }

  /**
   * Get participants for a conversation
   */
  async getConversationParticipants(conversationId) {
    const query = `
      SELECT u.id, u.name, u.email, u.role, u.profile_photo
      FROM chat_participants cp
      JOIN users u ON u.id = cp.user_id
      WHERE cp.conversation_id = $1
    `;
    const result = await pool.query(query, [conversationId]);
    return result.rows;
  }

  /**
   * Delete a conversation.
   * - Direct chat: any participant can delete the full chat thread.
   * - Group chat: only creator or ADMIN can delete the group.
   */
  async deleteConversation(conversationId, currentUserId, currentUserRole) {
    const convRes = await pool.query(
      'SELECT id, created_by, COALESCE(is_group, false) AS is_group, group_name FROM chat_conversations WHERE id = $1',
      [conversationId]
    );
    const conversation = convRes.rows[0];
    if (!conversation) throw new Error('Conversation not found');

    const isParticipant = await ChatConversation.isParticipant(conversationId, currentUserId, pool);
    if (!isParticipant) throw new Error('Not a participant of this conversation');

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
