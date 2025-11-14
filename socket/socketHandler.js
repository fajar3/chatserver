// src/socket/socketHandler.js
const jwt = require('jsonwebtoken');
const db = require('../config/database');

const connectedUsers = new Map(); // userId -> socketId

module.exports = (io) => {
  // Authentication middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    
    if (!token) {
      return next(new Error('Authentication error'));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId;
      next();
    } catch (error) {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', async (socket) => {
    const userId = socket.userId;
    console.log(`User connected: ${userId}`);

    // Store user connection
    connectedUsers.set(userId, socket.id);

    // Update user status to online
    await db.query('UPDATE users SET is_online = true WHERE id = $1', [userId]);

    // Notify other users
    socket.broadcast.emit('user_status', {
      userId,
      isOnline: true
    });

    // ========== CHAT EVENTS ==========

    // Join conversation room
    socket.on('join_conversation', (conversationId) => {
      socket.join(`conversation_${conversationId}`);
      console.log(`User ${userId} joined conversation ${conversationId}`);
    });

    // Leave conversation room
    socket.on('leave_conversation', (conversationId) => {
      socket.leave(`conversation_${conversationId}`);
    });

    // Send message
    socket.on('send_message', async (data) => {
      try {
        const { conversationId, messageText, messageType = 'text' } = data;

        // Save message to database
        const result = await db.query(`
          INSERT INTO messages (conversation_id, sender_id, message_text, message_type)
          VALUES ($1, $2, $3, $4)
          RETURNING id, conversation_id, sender_id, message_text, message_type, is_read, created_at
        `, [conversationId, userId, messageText, messageType]);

        const message = result.rows[0];

        // Get sender info
        const userResult = await db.query(
          'SELECT name, avatar_url FROM users WHERE id = $1',
          [userId]
        );
        const sender = userResult.rows[0];

        const messageData = {
          ...message,
          sender_name: sender.name,
          sender_avatar: sender.avatar_url
        };

        // Emit to conversation room
        io.to(`conversation_${conversationId}`).emit('new_message', messageData);

        // Get conversation participants for notification
        const participants = await db.query(`
          SELECT user_id FROM conversation_participants
          WHERE conversation_id = $1 AND user_id != $2
        `, [conversationId, userId]);

        // Send notification to offline users
        participants.rows.forEach(participant => {
          const recipientSocketId = connectedUsers.get(participant.user_id);
          if (recipientSocketId) {
            io.to(recipientSocketId).emit('message_notification', {
              conversationId,
              senderId: userId,
              senderName: sender.name,
              messagePreview: messageText.substring(0, 50)
            });
          }
        });

      } catch (error) {
        console.error('Send message error:', error);
        socket.emit('message_error', { error: 'Failed to send message' });
      }
    });

    // Mark messages as read
    socket.on('mark_as_read', async (data) => {
      try {
        const { conversationId, messageIds } = data;

        await db.query(`
          UPDATE messages
          SET is_read = true
          WHERE id = ANY($1) AND conversation_id = $2
        `, [messageIds, conversationId]);

        socket.to(`conversation_${conversationId}`).emit('messages_read', {
          conversationId,
          messageIds
        });
      } catch (error) {
        console.error('Mark as read error:', error);
      }
    });

    // Typing indicator
    socket.on('typing_start', (data) => {
      const { conversationId } = data;
      socket.to(`conversation_${conversationId}`).emit('user_typing', {
        userId,
        conversationId
      });
    });

    socket.on('typing_stop', (data) => {
      const { conversationId } = data;
      socket.to(`conversation_${conversationId}`).emit('user_stop_typing', {
        userId,
        conversationId
      });
    });

    // ========== WEBRTC CALL EVENTS ==========

    // Initiate call (voice or video)
    socket.on('initiate_call', async (data) => {
      try {
        const { receiverId, callType, offer } = data; // callType: 'voice' or 'video'

        // Create call log
        const callResult = await db.query(`
          INSERT INTO call_logs (caller_id, receiver_id, call_type, call_status)
          VALUES ($1, $2, $3, 'calling')
          RETURNING id
        `, [userId, receiverId, callType]);

        const callId = callResult.rows[0].id;

        // Get caller info
        const userResult = await db.query(
          'SELECT name, avatar_url FROM users WHERE id = $1',
          [userId]
        );
        const caller = userResult.rows[0];

        const receiverSocketId = connectedUsers.get(receiverId);
        
        if (receiverSocketId) {
          io.to(receiverSocketId).emit('incoming_call', {
            callId,
            callerId: userId,
            callerName: caller.name,
            callerAvatar: caller.avatar_url,
            callType,
            offer
          });
        } else {
          socket.emit('call_failed', {
            error: 'User is offline'
          });
          
          await db.query(
            'UPDATE call_logs SET call_status = $1 WHERE id = $2',
            ['missed', callId]
          );
        }
      } catch (error) {
        console.error('Initiate call error:', error);
        socket.emit('call_error', { error: 'Failed to initiate call' });
      }
    });

    // Answer call
    socket.on('answer_call', async (data) => {
      try {
        const { callId, callerId, answer } = data;

        // Update call status
        await db.query(`
          UPDATE call_logs
          SET call_status = 'answered', started_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [callId]);

        const callerSocketId = connectedUsers.get(callerId);
        
        if (callerSocketId) {
          io.to(callerSocketId).emit('call_answered', {
            callId,
            answer
          });
        }
      } catch (error) {
        console.error('Answer call error:', error);
      }
    });

    // ICE candidate exchange
    socket.on('ice_candidate', (data) => {
      const { receiverId, candidate } = data;
      const receiverSocketId = connectedUsers.get(receiverId);
      
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('ice_candidate', {
          senderId: userId,
          candidate
        });
      }
    });

    // Reject call
    socket.on('reject_call', async (data) => {
      try {
        const { callId, callerId } = data;

        await db.query(
          'UPDATE call_logs SET call_status = $1 WHERE id = $2',
          ['rejected', callId]
        );

        const callerSocketId = connectedUsers.get(callerId);
        
        if (callerSocketId) {
          io.to(callerSocketId).emit('call_rejected', { callId });
        }
      } catch (error) {
        console.error('Reject call error:', error);
      }
    });

    // End call
    socket.on('end_call', async (data) => {
      try {
        const { callId, receiverId } = data;

        // Calculate duration
        const callResult = await db.query(
          'SELECT started_at FROM call_logs WHERE id = $1',
          [callId]
        );

        if (callResult.rows.length > 0 && callResult.rows[0].started_at) {
          const startTime = new Date(callResult.rows[0].started_at);
          const endTime = new Date();
          const duration = Math.floor((endTime - startTime) / 1000); // seconds

          await db.query(`
            UPDATE call_logs
            SET call_status = 'ended', ended_at = CURRENT_TIMESTAMP, duration = $1
            WHERE id = $2
          `, [duration, callId]);
        } else {
          await db.query(
            'UPDATE call_logs SET call_status = $1 WHERE id = $2',
            ['missed', callId]
          );
        }

        const receiverSocketId = connectedUsers.get(receiverId);
        
        if (receiverSocketId) {
          io.to(receiverSocketId).emit('call_ended', { callId });
        }

        socket.emit('call_ended', { callId });
      } catch (error) {
        console.error('End call error:', error);
      }
    });

    // ========== DISCONNECT ==========

    socket.on('disconnect', async () => {
      console.log(`User disconnected: ${userId}`);
      
      // Remove from connected users
      connectedUsers.delete(userId);

      // Update user status
      await db.query(`
        UPDATE users
        SET is_online = false, last_seen = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [userId]);

      // Notify other users
      socket.broadcast.emit('user_status', {
        userId,
        isOnline: false
      });
    });
  });
};