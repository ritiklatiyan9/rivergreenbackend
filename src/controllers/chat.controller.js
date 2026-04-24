import asyncHandler from '../utils/asyncHandler.js';
import chatService from '../services/chat.service.js';
import fcmService from '../services/fcm.service.js';

// Fire-and-forget FCM push for a newly-created chat message. Runs after the
// HTTP response so it never blocks the sender, and never throws — chat
// delivery must keep working even if FCM is unreachable.
const pushChatNotification = (conversationId, senderId, msg) => {
  setImmediate(async () => {
    try {
      const participants = await chatService.getConversationParticipants(conversationId);
      const recipientIds = participants
        .map((p) => p.id)
        .filter((id) => id && id !== senderId);
      if (recipientIds.length === 0) return;

      const senderName = msg?.sender?.name || 'New message';
      const preview = msg?.message_text
        ? msg.message_text.slice(0, 140)
        : msg?.file_name
        ? `Sent a file: ${msg.file_name}`
        : 'New message';

      await fcmService.sendToUsers(recipientIds, {
        title: senderName,
        body: preview,
        data: {
          type: 'chat',
          conversation_id: String(conversationId),
          message_id: String(msg?.id ?? ''),
          sender_id: String(senderId),
          sender_name: senderName,
          // Deep-link target — the mobile app reads this on tap and
          // navigates with react-router to the conversation.
          route: `/chat?c=${encodeURIComponent(conversationId)}`,
        },
      });
    } catch (e) {
      console.error('[chat] FCM notify failed:', e?.message || e);
    }
  });
};

/**
 * GET /api/chat/conversations
 * Get all conversations for the authenticated user
 */
export const getConversations = asyncHandler(async (req, res) => {
  const conversations = await chatService.getUserConversations(req.user.id);
  res.json({ success: true, conversations });
});

/**
 * POST /api/chat/conversations
 * Start or get an existing conversation with another user
 * Body: { userId }
 */
export const startConversation = asyncHandler(async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ success: false, message: 'userId is required' });
  if (userId === req.user.id) {
    return res.status(400).json({ success: false, message: 'Cannot start conversation with yourself' });
  }

  const conversation = await chatService.getOrCreateConversation(req.user.id, userId);
  res.json({ success: true, conversation });
});

/**
 * POST /api/chat/groups
 * Create a group conversation
 * Body: { name, participantIds: [] }
 */
export const createGroupConversation = asyncHandler(async (req, res) => {
  const { name, participantIds } = req.body;

  if (!Array.isArray(participantIds)) {
    return res.status(400).json({ success: false, message: 'participantIds must be an array' });
  }

  try {
    const conversation = await chatService.createGroupConversation(req.user.id, name, participantIds);
    return res.status(201).json({ success: true, conversation });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message || 'Failed to create group' });
  }
});

/**
 * GET /api/chat/conversations/:id/messages
 * Get paginated messages for a conversation
 * Query: ?limit=30&before=messageId
 */
export const getMessages = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const limit = parseInt(req.query.limit) || 30;
  const before = req.query.before || null;

  const messages = await chatService.getMessages(id, req.user.id, { limit, before });
  res.json({ success: true, messages });
});

/**
 * DELETE /api/chat/conversations/:id
 * Delete direct chat or group chat
 */
export const deleteConversation = asyncHandler(async (req, res) => {
  const { id } = req.params;

  try {
    const result = await chatService.deleteConversation(id, req.user.id, req.user.role);
    const io = req.app.get('io');
    if (io) {
      const participants = await chatService.getConversationParticipants(id).catch(() => []);
      participants.forEach((p) => {
        io.to(`user_${p.id}`).emit('chat:conversationDeleted', { conversation_id: id });
      });
    }

    res.json({ success: true, result });
  } catch (err) {
    return res.status(403).json({ success: false, message: err.message || 'Failed to delete conversation' });
  }
});

/**
 * POST /api/chat/conversations/:id/messages
 * Send a text message
 * Body: { message }
 */
export const sendMessage = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ success: false, message: 'Message text is required' });

  const msg = await chatService.sendMessage(id, req.user.id, message.trim());

  // Emit via socket if available
  const io = req.app.get('io');
  if (io) {
    const participants = await chatService.getConversationParticipants(id);
    participants.forEach(p => {
      if (p.id !== req.user.id) {
        io.to(`user_${p.id}`).emit('chat:message', msg);
      }
    });
  }

  pushChatNotification(id, req.user.id, msg);
  res.status(201).json({ success: true, message: msg });
});

/**
 * POST /api/chat/conversations/:id/upload
 * Send a file/document message
 * Form data: file + optional message
 */
export const sendFileMessage = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!req.file) return res.status(400).json({ success: false, message: 'File is required' });

  const msg = await chatService.sendFileMessage(
    id, req.user.id, req.file, req.body.message
  );

  // Emit via socket if available
  const io = req.app.get('io');
  if (io) {
    const participants = await chatService.getConversationParticipants(id);
    participants.forEach(p => {
      if (p.id !== req.user.id) {
        io.to(`user_${p.id}`).emit('chat:message', msg);
      }
    });
  }

  pushChatNotification(id, req.user.id, msg);
  res.status(201).json({ success: true, message: msg });
});

/**
 * PUT /api/chat/messages/:id
 * Edit a message
 * Body: { message }
 */
export const editMessage = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ success: false, message: 'Message text is required' });

  try {
    const msg = await chatService.editMessage(id, req.user.id, message.trim(), req.user.role);

    const io = req.app.get('io');
    if (io) {
      const participants = await chatService.getConversationParticipants(msg.conversation_id);
      participants.forEach(p => {
        io.to(`user_${p.id}`).emit('chat:messageUpdated', msg);
      });
    }

    res.json({ success: true, message: msg });
  } catch (err) {
    return res.status(403).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /api/chat/messages/:id
 * Soft delete a message
 */
export const deleteMessage = asyncHandler(async (req, res) => {
  const { id } = req.params;

  try {
    const msg = await chatService.deleteMessage(id, req.user.id, req.user.role);

    const io = req.app.get('io');
    if (io) {
      const participants = await chatService.getConversationParticipants(msg.conversation_id);
      participants.forEach(p => {
        io.to(`user_${p.id}`).emit('chat:messageDeleted', { id: msg.id, conversation_id: msg.conversation_id });
      });
    }

    res.json({ success: true, message: 'Message deleted' });
  } catch (err) {
    return res.status(403).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/chat/users
 * Get all users available for chat
 */
export const getChatUsers = asyncHandler(async (req, res) => {
  const users = await chatService.getChatUsers(req.user.id);
  res.json({ success: true, users });
});

/**
 * GET /api/chat/permissions
 * Get all chat permissions (admin only)
 */
export const getPermissions = asyncHandler(async (req, res) => {
  const permissions = await chatService.getAllPermissions();
  res.json({ success: true, permissions });
});

/**
 * PUT /api/chat/permissions/:roleName
 * Update chat permission for a role (admin only)
 * Body: { can_edit_message, can_delete_message }
 */
export const updatePermission = asyncHandler(async (req, res) => {
  const { roleName } = req.params;
  const { can_edit_message, can_delete_message } = req.body;

  const permission = await chatService.updatePermission(roleName, { can_edit_message, can_delete_message });
  if (!permission) return res.status(404).json({ success: false, message: 'Role not found' });

  res.json({ success: true, permission });
});

/**
 * GET /api/chat/my-permissions
 * Get chat permissions for the current user's role
 */
export const getMyPermissions = asyncHandler(async (req, res) => {
  const permission = await chatService.getUserPermission(req.user.role);
  res.json({ success: true, permission: permission || { can_edit_message: false, can_delete_message: false } });
});
