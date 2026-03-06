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

    // Upload to Cloudinary
    const result = await uploadSingle(file, 'cloudinary');

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
}

export default new ChatService();
