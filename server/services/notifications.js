const { getDb } = require('../database');

function createNotification(userId, type, title, message, referenceType = null, referenceId = null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO notifications (user_id, type, title, message, reference_type, reference_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, type, title, message, referenceType, referenceId);
}

function notifyStakeholders(excludeUserId, type, title, message, referenceType, referenceId) {
  const db = getDb();
  const users = db.prepare('SELECT id FROM users WHERE id != ?').all(excludeUserId);
  for (const user of users) {
    createNotification(user.id, type, title, message, referenceType, referenceId);
  }
}

function getUserNotifications(userId, unreadOnly = false) {
  const db = getDb();
  let query = 'SELECT * FROM notifications WHERE user_id = ?';
  if (unreadOnly) query += ' AND read = 0';
  query += ' ORDER BY created_at DESC LIMIT 100';
  return db.prepare(query).all(userId);
}

function markRead(notificationId, userId) {
  const db = getDb();
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(notificationId, userId);
}

function markAllRead(userId) {
  const db = getDb();
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(userId);
}

module.exports = { createNotification, notifyStakeholders, getUserNotifications, markRead, markAllRead };
