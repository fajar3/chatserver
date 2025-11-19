// socketHandler.js - COMPLETE SOCKET.IO IMPLEMENTATION

const jwt = require('jsonwebtoken');
const db = require('../config/database');

// Store active users and their socket connections
const activeUsers = new Map(); // userId -> {socketId, socket}
const activeCallSessions = new Map(); // callId -> {caller, receiver, type, sdp}

module.exports = (io) => {
  // Middleware untuk autentikasi
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) {
        return next(new Error('Authentication required'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId;
      next();
    } catch (error) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`User ${socket.userId} connected: ${socket.id}`);

    // User connected - register user
    socket.on('user_connected', async (data) => {
      try {
        const userId = socket.userId;
        
        // Store user connection
        activeUsers.set(userId, {
          socketId: socket.id,
          socket: socket,
          connectedAt: new Date()
        });

        // Update online status
        await db.query(
          'UPDATE users SET is_online = true, last_seen = NOW() WHERE id = $1',
          [userId]
        );

        console.log(`User ${userId} is now online`);
        
        // Broadcast user is online
        io.emit('user_status_changed', {
          userId,
          status: 'online'
        });

        socket.emit('connection_confirmed', {
          userId,
          message: 'Successfully connected'
        });
      } catch (error) {
        console.error('user_connected error:', error);
      }
    });

    // ==================== CHAT EVENTS ====================

    socket.on('send_message', async (data) => {
      try {
        const { conversationId, messageText, messageType } = data;
        const senderId = socket.userId;

        // Save message to database
        const result = await db.query(
          `INSERT INTO messages (conversation_id, sender_id, message_text, message_type, is_read)
           VALUES ($1, $2, $3, $4, false)
           RETURNING id, created_at`,
          [conversationId, senderId, messageText, messageType || 'text']
        );

        const message = result.rows[0];

        // Get receiver info
        const receiverResult = await db.query(
          `SELECT DISTINCT cp.user_id
           FROM conversation_participants cp
           WHERE cp.conversation_id = $1 AND cp.user_id != $2`,
          [conversationId, senderId]
        );

        if (receiverResult.rows.length > 0) {
          const receiverId = receiverResult.rows[0].user_id;
          const receiverUser = activeUsers.get(receiverId);

          // Send to receiver if online
          if (receiverUser) {
            receiverUser.socket.emit('new_message', {
              conversationId,
              messageId: message.id,
              senderId,
              messageText,
              messageType: messageType || 'text',
              created_at: message.created_at,
              is_read: false
            });
          }
        }

        // Confirm to sender
        socket.emit('message_sent', {
          messageId: message.id,
          created_at: message.created_at
        });

      } catch (error) {
        console.error('send_message error:', error);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // ==================== CALL EVENTS ====================

    socket.on('initiate_call', async (data) => {
      try {
        const { receiverId, callType } = data;
        const callerId = socket.userId;

        const callId = `${callerId}_${receiverId}_${Date.now()}`;

        // Get caller info
        const callerResult = await db.query(
          'SELECT id, name FROM users WHERE id = $1',
          [callerId]
        );

        const caller = callerResult.rows[0];

        // Store call session
        activeCallSessions.set(callId, {
          callId,
          callerId,
          receiverId,
          callType,
          status: 'ringing',
          createdAt: new Date(),
          sdp: null
        });

        // Find receiver socket
        const receiverUser = activeUsers.get(receiverId);

        if (receiverUser) {
          // Send incoming call to receiver
          receiverUser.socket.emit('incoming_call', {
            callId,
            callerId,
            callerName: caller.name,
            callType,
            timestamp: new Date()
          });

          // Notify caller that call is being sent
          socket.emit('call_initiated', {
            callId,
            receiverId,
            callType,
            status: 'ringing'
          });
        } else {
          // Receiver is offline
          socket.emit('call_error', {
            message: 'User is offline',
            receiverId
          });

          activeCallSessions.delete(callId);
        }

      } catch (error) {
        console.error('initiate_call error:', error);
        socket.emit('error', { message: 'Failed to initiate call' });
      }
    });

    socket.on('answer_call', async (data) => {
      try {
        const { callId, sdp } = data;
        const receiverId = socket.userId;

        const callSession = activeCallSessions.get(callId);
        
        if (!callSession) {
          socket.emit('error', { message: 'Call not found' });
          return;
        }

        // Update call session
        callSession.status = 'active';
        callSession.sdp = sdp;
        callSession.answeredAt = new Date();

        // Get receiver info
        const receiverResult = await db.query(
          'SELECT id, name FROM users WHERE id = $1',
          [receiverId]
        );

        const receiver = receiverResult.rows[0];

        // Send answer to caller
        const callerUser = activeUsers.get(callSession.callerId);
        if (callerUser) {
          callerUser.socket.emit('call_answered', {
            callId,
            receiverId,
            receiverName: receiver.name,
            sdp,
            callType: callSession.callType
          });
        }

        // Notify receiver
        socket.emit('call_connected', {
          callId,
          status: 'active'
        });

      } catch (error) {
        console.error('answer_call error:', error);
        socket.emit('error', { message: 'Failed to answer call' });
      }
    });

    socket.on('reject_call', async (data) => {
      try {
        const { callId } = data;
        const receiverId = socket.userId;

        const callSession = activeCallSessions.get(callId);
        
        if (!callSession) {
          return;
        }

        // Notify caller
        const callerUser = activeUsers.get(callSession.callerId);
        if (callerUser) {
          callerUser.socket.emit('call_rejected', {
            callId,
            reason: 'rejected'
          });
        }

        // Delete call session
        activeCallSessions.delete(callId);

      } catch (error) {
        console.error('reject_call error:', error);
      }
    });

    socket.on('ice_candidate', (data) => {
      try {
        const { callId, candidate } = data;
        const userId = socket.userId;

        const callSession = activeCallSessions.get(callId);
        
        if (!callSession) {
          return;
        }

        // Determine if sender is caller or receiver
        let targetUserId;
        if (callSession.callerId === userId) {
          targetUserId = callSession.receiverId;
        } else {
          targetUserId = callSession.callerId;
        }

        // Send ICE candidate to other party
        const targetUser = activeUsers.get(targetUserId);
        if (targetUser) {
          targetUser.socket.emit('ice_candidate', {
            callId,
            candidate
          });
        }

      } catch (error) {
        console.error('ice_candidate error:', error);
      }
    });

    socket.on('end_call', async (data) => {
      try {
        const { callId } = data;
        const userId = socket.userId;

        const callSession = activeCallSessions.get(callId);
        
        if (!callSession) {
          return;
        }

        // Determine if sender is caller or receiver
        let otherUserId;
        if (callSession.callerId === userId) {
          otherUserId = callSession.receiverId;
        } else {
          otherUserId = callSession.callerId;
        }

        // Save call log
        const callType = callSession.callType;
        const duration = Math.floor((new Date() - callSession.createdAt) / 1000);

        await db.query(
          `INSERT INTO call_logs (caller_id, receiver_id, call_type, call_status, duration)
           VALUES ($1, $2, $3, $4, $5)`,
          [callSession.callerId, callSession.receiverId, callType, 'completed', duration]
        );

        // Notify other party
        const otherUser = activeUsers.get(otherUserId);
        if (otherUser) {
          otherUser.socket.emit('call_ended', {
            callId,
            reason: 'ended_by_user',
            duration
          });
        }

        // Delete call session
        activeCallSessions.delete(callId);

      } catch (error) {
        console.error('end_call error:', error);
      }
    });

    // ==================== DISCONNECT EVENTS ====================

    socket.on('disconnect', async () => {
      try {
        const userId = socket.userId;

        // Remove from active users
        activeUsers.delete(userId);

        // Update user offline status
        await db.query(
          'UPDATE users SET is_online = false, last_seen = NOW() WHERE id = $1',
          [userId]
        );

        console.log(`User ${userId} disconnected`);

        // Broadcast user is offline
        io.emit('user_status_changed', {
          userId,
          status: 'offline'
        });

        // End any active calls
        for (const [callId, callSession] of activeCallSessions.entries()) {
          if (callSession.callerId === userId || callSession.receiverId === userId) {
            let otherUserId;
            if (callSession.callerId === userId) {
              otherUserId = callSession.receiverId;
            } else {
              otherUserId = callSession.callerId;
            }

            const otherUser = activeUsers.get(otherUserId);
            if (otherUser) {
              otherUser.socket.emit('call_ended', {
                callId,
                reason: 'user_disconnected'
              });
            }

            activeCallSessions.delete(callId);
          }
        }

      } catch (error) {
        console.error('disconnect error:', error);
      }
    });

    // Error handling
    socket.on('error', (error) => {
      console.error(`Socket error for user ${socket.userId}:`, error);
    });
  });

  console.log('Socket.IO initialized');
};