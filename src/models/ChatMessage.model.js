import MasterModel from './MasterModel.js';

class ChatMessageModel extends MasterModel {
  constructor() {
    super('chat_messages');
  }

  /**
   * Get paginated messages for a conversation (newest first for pagination, reversed for display)
   */
  async getMessages(conversationId, { limit = 30, before = null } = {}, pool) {
    let query;
    let params;

    if (before) {
      query = `
        SELECT
          m.id, m.conversation_id, m.sender_id, m.message_text, m.message_type,
          m.file_url, m.file_name, m.created_at, m.updated_at, m.is_deleted,
          u.name AS sender_name, u.profile_photo AS sender_photo, u.role AS sender_role
        FROM chat_messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = $1 AND m.created_at < (SELECT created_at FROM chat_messages WHERE id = $2)
        ORDER BY m.created_at DESC
        LIMIT $3
      `;
      params = [conversationId, before, limit];
    } else {
      query = `
        SELECT
          m.id, m.conversation_id, m.sender_id, m.message_text, m.message_type,
          m.file_url, m.file_name, m.created_at, m.updated_at, m.is_deleted,
          u.name AS sender_name, u.profile_photo AS sender_photo, u.role AS sender_role
        FROM chat_messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = $1
        ORDER BY m.created_at DESC
        LIMIT $2
      `;
      params = [conversationId, limit];
    }

    const result = await pool.query(query, params);
    return result.rows.reverse(); // Return in chronological order
  }

  /**
   * Create a new message
   */
  async createMessage(data, pool) {
    const { conversation_id, sender_id, message_text, message_type, file_url, file_name } = data;
    const query = `
      INSERT INTO chat_messages (conversation_id, sender_id, message_text, message_type, file_url, file_name)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const result = await pool.query(query, [
      conversation_id, sender_id, message_text || null,
      message_type || 'text', file_url || null, file_name || null
    ]);
    return result.rows[0];
  }

  /**
   * Get a message with sender info
   */
  async getMessageWithSender(messageId, pool) {
    const query = `
      SELECT
        m.id, m.conversation_id, m.sender_id, m.message_text, m.message_type,
        m.file_url, m.file_name, m.created_at, m.updated_at, m.is_deleted,
        u.name AS sender_name, u.profile_photo AS sender_photo, u.role AS sender_role
      FROM chat_messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.id = $1
    `;
    const result = await pool.query(query, [messageId]);
    return result.rows[0];
  }

  /**
   * Edit a message (only by the sender)
   */
  async editMessage(messageId, senderId, newText, pool) {
    const query = `
      UPDATE chat_messages
      SET message_text = $1, updated_at = NOW()
      WHERE id = $2 AND sender_id = $3 AND is_deleted = false
      RETURNING *
    `;
    const result = await pool.query(query, [newText, messageId, senderId]);
    return result.rows[0];
  }

  /**
   * Soft delete a message (only by the sender)
   */
  async softDelete(messageId, senderId, pool) {
    const query = `
      UPDATE chat_messages
      SET is_deleted = true, updated_at = NOW()
      WHERE id = $1 AND sender_id = $2
      RETURNING *
    `;
    const result = await pool.query(query, [messageId, senderId]);
    return result.rows[0];
  }
}

export default new ChatMessageModel();
