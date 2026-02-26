const { getDb } = require('../database');

function logAction(userId, action, entityType, entityId, details = null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, action, entityType, entityId, details ? JSON.stringify(details) : null);
}

function getAuditLog(entityType, entityId, limit = 50) {
  const db = getDb();
  return db.prepare(`
    SELECT al.*, u.full_name as user_name
    FROM audit_log al
    LEFT JOIN users u ON al.user_id = u.id
    WHERE al.entity_type = ? AND al.entity_id = ?
    ORDER BY al.created_at DESC
    LIMIT ?
  `).all(entityType, entityId, limit);
}

function getRecentActivity(limit = 50) {
  const db = getDb();
  return db.prepare(`
    SELECT al.*, u.full_name as user_name
    FROM audit_log al
    LEFT JOIN users u ON al.user_id = u.id
    ORDER BY al.created_at DESC
    LIMIT ?
  `).all(limit);
}

module.exports = { logAction, getAuditLog, getRecentActivity };
