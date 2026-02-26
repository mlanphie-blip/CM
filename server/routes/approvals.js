const express = require('express');
const { getDb } = require('../database');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAction } = require('../services/audit');
const { createNotification, notifyStakeholders } = require('../services/notifications');

const router = express.Router();

// Get approval dashboard
router.get('/dashboard', authenticate, (req, res) => {
  const db = getDb();

  const pendingReviews = db.prepare(`
    SELECT a.*, p.title as proposal_title, p.status as proposal_status,
      c.title as contract_title, u.full_name as proposer_name
    FROM approvals a
    JOIN proposals p ON a.proposal_id = p.id
    JOIN contracts c ON p.contract_id = c.id
    JOIN users u ON p.proposer_id = u.id
    WHERE a.reviewer_id = ? AND a.decision = 'pending'
    ORDER BY a.required DESC, a.created_at ASC
  `).all(req.user.id);

  const myDecisions = db.prepare(`
    SELECT a.*, p.title as proposal_title, c.title as contract_title
    FROM approvals a
    JOIN proposals p ON a.proposal_id = p.id
    JOIN contracts c ON p.contract_id = c.id
    WHERE a.reviewer_id = ? AND a.decision != 'pending'
    ORDER BY a.decided_at DESC LIMIT 20
  `).all(req.user.id);

  const allPending = db.prepare(`
    SELECT p.id, p.title, p.status, c.title as contract_title, u.full_name as proposer_name,
      (SELECT COUNT(*) FROM approvals a WHERE a.proposal_id = p.id AND a.decision = 'approved') as approvals,
      (SELECT COUNT(*) FROM approvals a WHERE a.proposal_id = p.id AND a.decision = 'rejected') as rejections,
      (SELECT COUNT(*) FROM approvals a WHERE a.proposal_id = p.id AND a.decision = 'pending') as pending
    FROM proposals p
    JOIN contracts c ON p.contract_id = c.id
    JOIN users u ON p.proposer_id = u.id
    WHERE p.status = 'under_review'
    ORDER BY p.updated_at DESC
  `).all();

  res.json({ pendingReviews, myDecisions, allPending });
});

// Add reviewer to proposal
router.post('/', authenticate, requireRole('admin', 'editor'), (req, res) => {
  const { proposal_id, reviewer_id, required } = req.body;
  if (!proposal_id || !reviewer_id) {
    return res.status(400).json({ error: 'proposal_id and reviewer_id required' });
  }

  const db = getDb();
  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(proposal_id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  try {
    db.prepare(`
      INSERT INTO approvals (proposal_id, reviewer_id, required) VALUES (?, ?, ?)
    `).run(proposal_id, reviewer_id, required ? 1 : 0);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Reviewer already assigned' });
    }
    throw err;
  }

  createNotification(reviewer_id, 'review_requested', 'Review Requested',
    `You have been asked to review "${proposal.title}"`, 'proposal', proposal_id);
  logAction(req.user.id, 'assign_reviewer', 'approval', proposal_id, { reviewer_id });

  res.status(201).json({ message: 'Reviewer assigned' });
});

// Submit approval decision
router.put('/:proposalId/decide', authenticate, (req, res) => {
  const { decision, comments } = req.body;
  if (!decision || !['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be "approved" or "rejected"' });
  }

  const db = getDb();
  const approval = db.prepare('SELECT * FROM approvals WHERE proposal_id = ? AND reviewer_id = ?')
    .get(req.params.proposalId, req.user.id);

  if (!approval) {
    // Auto-create approval entry
    db.prepare(`
      INSERT INTO approvals (proposal_id, reviewer_id, decision, comments, decided_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(req.params.proposalId, req.user.id, decision, comments || '');
  } else {
    db.prepare(`
      UPDATE approvals SET decision = ?, comments = ?, decided_at = CURRENT_TIMESTAMP WHERE proposal_id = ? AND reviewer_id = ?
    `).run(decision, comments || '', req.params.proposalId, req.user.id);
  }

  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.proposalId);

  // Check if all required approvals are in
  const pendingRequired = db.prepare(`
    SELECT COUNT(*) as count FROM approvals WHERE proposal_id = ? AND required = 1 AND decision = 'pending'
  `).get(req.params.proposalId);

  const hasRejection = db.prepare(`
    SELECT COUNT(*) as count FROM approvals WHERE proposal_id = ? AND decision = 'rejected'
  `).get(req.params.proposalId);

  // Auto-update proposal status
  if (hasRejection.count > 0) {
    db.prepare("UPDATE proposals SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.proposalId);
    notifyStakeholders(req.user.id, 'proposal_rejected', 'Proposal Rejected',
      `"${proposal.title}" has been rejected`, 'proposal', Number(req.params.proposalId));
  } else if (pendingRequired.count === 0) {
    const allApproved = db.prepare(`
      SELECT COUNT(*) as count FROM approvals WHERE proposal_id = ? AND decision = 'approved'
    `).get(req.params.proposalId);
    if (allApproved.count > 0) {
      db.prepare("UPDATE proposals SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.proposalId);
      notifyStakeholders(req.user.id, 'proposal_approved', 'Proposal Approved',
        `"${proposal.title}" has been approved`, 'proposal', Number(req.params.proposalId));
    }
  }

  logAction(req.user.id, 'approval_decision', 'approval', Number(req.params.proposalId), { decision });

  // Notify proposal owner
  if (proposal && proposal.proposer_id !== req.user.id) {
    createNotification(proposal.proposer_id, 'approval_decision', `Review ${decision}`,
      `${req.user.full_name} ${decision} "${proposal.title}"`, 'proposal', Number(req.params.proposalId));
  }

  res.json({ message: `Decision recorded: ${decision}` });
});

module.exports = router;
