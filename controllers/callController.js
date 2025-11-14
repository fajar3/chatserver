// src/controllers/callController.js
const db = require('../config/database');

const getCallHistory = async (req, res) => {
  try {
    const userId = req.userId;

    const result = await db.query(`
      SELECT 
        cl.id,
        cl.call_type,
        cl.call_status,
        cl.duration,
        cl.started_at,
        cl.ended_at,
        cl.caller_id,
        cl.receiver_id,
        CASE 
          WHEN cl.caller_id = $1 THEN receiver.name
          ELSE caller.name
        END as contact_name,
        CASE 
          WHEN cl.caller_id = $1 THEN receiver.avatar_url
          ELSE caller.avatar_url
        END as contact_avatar,
        CASE 
          WHEN cl.caller_id = $1 THEN 'outgoing'
          ELSE 'incoming'
        END as call_direction
      FROM call_logs cl
      INNER JOIN users caller ON cl.caller_id = caller.id
      INNER JOIN users receiver ON cl.receiver_id = receiver.id
      WHERE cl.caller_id = $1 OR cl.receiver_id = $1
      ORDER BY cl.started_at DESC
      LIMIT 50
    `, [userId]);

    res.json({ calls: result.rows });
  } catch (error) {
    console.error('Get call history error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

const getCallDetails = async (req, res) => {
  try {
    const { callId } = req.params;
    const userId = req.userId;

    const result = await db.query(`
      SELECT 
        cl.*,
        caller.name as caller_name,
        caller.avatar_url as caller_avatar,
        receiver.name as receiver_name,
        receiver.avatar_url as receiver_avatar
      FROM call_logs cl
      INNER JOIN users caller ON cl.caller_id = caller.id
      INNER JOIN users receiver ON cl.receiver_id = receiver.id
      WHERE cl.id = $1 AND (cl.caller_id = $2 OR cl.receiver_id = $2)
    `, [callId, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Call not found' });
    }

    res.json({ call: result.rows[0] });
  } catch (error) {
    console.error('Get call details error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

const deleteCallLog = async (req, res) => {
  try {
    const { callId } = req.params;
    const userId = req.userId;

    // Verify user is part of the call
    const verifyResult = await db.query(
      'SELECT id FROM call_logs WHERE id = $1 AND (caller_id = $2 OR receiver_id = $2)',
      [callId, userId]
    );

    if (verifyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Call not found' });
    }

    await db.query('DELETE FROM call_logs WHERE id = $1', [callId]);

    res.json({ message: 'Call log deleted successfully' });
  } catch (error) {
    console.error('Delete call log error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

const getCallStatistics = async (req, res) => {
  try {
    const userId = req.userId;

    // Total calls
    const totalResult = await db.query(
      'SELECT COUNT(*) as total FROM call_logs WHERE caller_id = $1 OR receiver_id = $1',
      [userId]
    );

    // Missed calls
    const missedResult = await db.query(
      'SELECT COUNT(*) as missed FROM call_logs WHERE receiver_id = $1 AND call_status = $2',
      [userId, 'missed']
    );

    // Total duration
    const durationResult = await db.query(
      'SELECT SUM(duration) as total_duration FROM call_logs WHERE (caller_id = $1 OR receiver_id = $1) AND duration IS NOT NULL',
      [userId]
    );

    // Call types breakdown
    const typesResult = await db.query(`
      SELECT 
        call_type,
        COUNT(*) as count
      FROM call_logs
      WHERE caller_id = $1 OR receiver_id = $1
      GROUP BY call_type
    `, [userId]);

    res.json({
      statistics: {
        total_calls: parseInt(totalResult.rows[0].total),
        missed_calls: parseInt(missedResult.rows[0].missed),
        total_duration_seconds: parseInt(durationResult.rows[0].total_duration || 0),
        call_types: typesResult.rows
      }
    });
  } catch (error) {
    console.error('Get call statistics error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  getCallHistory,
  getCallDetails,
  deleteCallLog,
  getCallStatistics
};

