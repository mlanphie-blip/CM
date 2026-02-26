const express = require('express');
const { getDb } = require('../database');
const { authenticate } = require('../middleware/auth');
const { logAction } = require('../services/audit');
const { createNotification } = require('../services/notifications');

const router = express.Router();

// Add feedback/comment to proposal
router.post('/', authenticate, (req, res) => {
  const { proposal_id, comment_text, parent_feedback_id } = req.body;
  if (!proposal_id || !comment_text) {
    return res.status(400).json({ error: 'proposal_id and comment_text required' });
  }

  const db = getDb();
  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposal_id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  const result = db.prepare(`
    INSERT INTO feedback (proposal_id, commenter_id, comment_text, parent_feedback_id)
    VALUES (?, ?, ?, ?)
  `).run(proposal_id, req.user.id, comment_text, parent_feedback_id || null);

  logAction(req.user.id, 'add_feedback', 'feedback', result.lastInsertRowid, { proposal_id });

  // Notify the proposal owner
  if (proposal.proposer_id !== req.user.id) {
    createNotification(proposal.proposer_id, 'new_feedback', 'New Feedback',
      `${req.user.full_name} commented on "${proposal.title}"`, 'proposal', proposal_id);
  }

  // If this is a reply, notify the parent commenter
  if (parent_feedback_id) {
    const parent = db.prepare('SELECT commenter_id FROM feedback WHERE id = ?').get(parent_feedback_id);
    if (parent && parent.commenter_id !== req.user.id) {
      createNotification(parent.commenter_id, 'feedback_reply', 'Reply to Your Comment',
        `${req.user.full_name} replied to your comment on "${proposal.title}"`, 'proposal', proposal_id);
    }
  }

  res.status(201).json({ id: result.lastInsertRowid });
});

// Update feedback status
router.put('/:id', authenticate, (req, res) => {
  const { status, comment_text } = req.body;
  const db = getDb();

  const feedback = db.prepare('SELECT * FROM feedback WHERE id = ?').get(req.params.id);
  if (!feedback) return res.status(404).json({ error: 'Feedback not found' });

  const updates = [];
  const params = [];
  if (status) { updates.push('status = ?'); params.push(status); }
  if (comment_text) { updates.push('comment_text = ?'); params.push(comment_text); }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);

  db.prepare(`UPDATE feedback SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  logAction(req.user.id, 'update_feedback', 'feedback', Number(req.params.id), { status });

  res.json({ message: 'Feedback updated' });
});

// Delete feedback
router.delete('/:id', authenticate, (req, res) => {
  const db = getDb();
  const feedback = db.prepare('SELECT * FROM feedback WHERE id = ?').get(req.params.id);
  if (!feedback) return res.status(404).json({ error: 'Feedback not found' });

  if (feedback.commenter_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the commenter or admin can delete' });
  }

  db.prepare('DELETE FROM feedback WHERE id = ?').run(req.params.id);
  logAction(req.user.id, 'delete_feedback', 'feedback', Number(req.params.id));
  res.json({ message: 'Feedback deleted' });
});

module.exports = router;
