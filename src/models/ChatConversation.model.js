import MasterModel from './MasterModel.js';

class ChatConversationModel extends MasterModel {
  constructor() {
    super('chat_conversations');
  }

  /**
   * Find an existing 1-on-1 conversation between two users
   */
  async findDirectConversation(userId1, userId2, pool) {
    const query = `
      SELECT c.id, c.created_by, c.created_at
      FROM chat_conversations c
      WHERE (
        SELECT COUNT(*) FROM chat_participants cp WHERE cp.conversation_id = c.id
      ) = 2
      AND EXISTS (
        SELECT 1 FROM chat_participants cp WHERE cp.conversation_id = c.id AND cp.user_id = $1
      )
      AND EXISTS (
        SELECT 1 FROM chat_participants cp WHERE cp.conversation_id = c.id AND cp.user_id = $2
      )
      LIMIT 1
    `;
    const result = await pool.query(query, [userId1, userId2]);
    return result.rows[0] || null;
  }

  /**
   * Create a new conversation with participants
   */
  async createWithParticipants(createdBy, participantIds, pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const convResult = await client.query(
        'INSERT INTO chat_conversations (created_by) VALUES ($1) RETURNING *',
        [createdBy]
      );
      const conversation = convResult.rows[0];

      for (const userId of participantIds) {
        await client.query(
          'INSERT INTO chat_participants (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [conversation.id, userId]
        );
      }

      await client.query('COMMIT');
      return conversation;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get all conversations for a user with last message and other participant info
   */
  async getUserConversations(userId, pool) {
    const query = `
      SELECT
        c.id,
        c.created_at,
        (
          SELECT json_build_object(
            'id', m.id,
            'message_text', CASE WHEN m.is_deleted THEN 'This message was deleted' ELSE m.message_text END,
            'message_type', m.message_type,
            'file_name', m.file_name,
            'sender_id', m.sender_id,
            'created_at', m.created_at,
            'is_deleted', m.is_deleted
          )
          FROM chat_messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC
          LIMIT 1
        ) AS last_message,
        (
          SELECT json_agg(json_build_object(
            'id', u.id,
            'name', u.name,
            'email', u.email,
            'role', u.role,
            'profile_photo', u.profile_photo
          ))
          FROM chat_participants cp2
          JOIN users u ON u.id = cp2.user_id
          WHERE cp2.conversation_id = c.id AND cp2.user_id != $1
        ) AS other_participants
      FROM chat_conversations c
      JOIN chat_participants cp ON cp.conversation_id = c.id AND cp.user_id = $1
      ORDER BY (
        SELECT MAX(m2.created_at) FROM chat_messages m2 WHERE m2.conversation_id = c.id
      ) DESC NULLS LAST
    `;
    const result = await pool.query(query, [userId]);
    return result.rows;
  }

  /**
   * Check if a user is participant of a conversation
   */
  async isParticipant(conversationId, userId, pool) {
    const result = await pool.query(
      'SELECT 1 FROM chat_participants WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );
    return result.rows.length > 0;
  }
}

export default new ChatConversationModel();
