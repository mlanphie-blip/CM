const express = require('express');
const { authenticate } = require('../middleware/auth');
const { getUserNotifications, markRead, markAllRead } = require('../services/notifications');
const { getRecentActivity } = require('../services/audit');

const router = express.Router();

// Get user notifications
router.get('/', authenticate, (req, res) => {
  const unreadOnly = req.query.unread === 'true';
  res.json(getUserNotifications(req.user.id, unreadOnly));
});

// Mark notification as read
router.put('/:id/read', authenticate, (req, res) => {
  markRead(req.params.id, req.user.id);
  res.json({ message: 'Marked as read' });
});

// Mark all as read
router.put('/read-all', authenticate, (req, res) => {
  markAllRead(req.user.id);
  res.json({ message: 'All marked as read' });
});

// Get recent activity feed
router.get('/activity', authenticate, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(getRecentActivity(limit));
});

module.exports = router;
