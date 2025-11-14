const db = require('../config/database');

const getConversations = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT DISTINCT ON (c.id) 
        c.id as conversation_id,
        u.id as user_id,
        u.name as user_name,
        u.avatar_url,
        u.is_online,
        m.message_text as last_message,
        m.created_at as last_message_time
      FROM conversations c
      INNER JOIN conversation_participants cp ON c.id = cp.conversation_id
      INNER JOIN conversation_participants cp2 ON c.id = cp2.conversation_id AND cp2.user_id != $1
      INNER JOIN users u ON cp2.user_id = u.id
      LEFT JOIN messages m ON c.id = m.conversation_id
      WHERE cp.user_id = $1
      ORDER BY c.id, m.created_at DESC
    `, [req.userId]);

    res.json({ conversations: result.rows });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

const getMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const result = await db.query(`
      SELECT 
        m.id,
        m.message_text,
        m.message_type,
        m.is_read,
        m.created_at,
        m.sender_id,
        u.name as sender_name,
        u.avatar_url as sender_avatar
      FROM messages m
      INNER JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = $1
      ORDER BY m.created_at DESC
      LIMIT $2 OFFSET $3
    `, [conversationId, limit, offset]);

    res.json({ messages: result.rows.reverse() });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

const createConversation = async (req, res) => {
  try {
    const { receiverId } = req.body;

    // Check if conversation exists
    const existingConv = await db.query(`
      SELECT c.id
      FROM conversations c
      INNER JOIN conversation_participants cp1 ON c.id = cp1.conversation_id
      INNER JOIN conversation_participants cp2 ON c.id = cp2.conversation_id
      WHERE cp1.user_id = $1 AND cp2.user_id = $2
      LIMIT 1
    `, [req.userId, receiverId]);

    if (existingConv.rows.length > 0) {
      return res.json({ conversationId: existingConv.rows[0].id });
    }

    // Create new conversation
    const newConv = await db.query(
      'INSERT INTO conversations DEFAULT VALUES RETURNING id'
    );
    const conversationId = newConv.rows[0].id;

    // Add participants
    await db.query(
      'INSERT INTO conversation_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)',
      [conversationId, req.userId, receiverId]
    );

    res.status(201).json({ conversationId });
  } catch (error) {
    console.error('Create conversation error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

const searchUsers = async (req, res) => {
  try {
    const { query } = req.query;

    const result = await db.query(`
      SELECT id, name, email, avatar_url, is_online
      FROM users
      WHERE (name ILIKE $1 OR email ILIKE $1) AND id != $2
      LIMIT 20
    `, [`%${query}%`, req.userId]);

    res.json({ users: result.rows });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getConversations,
  getMessages,
  createConversation,
  searchUsers
};