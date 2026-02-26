const express = require('express');
const { getDb } = require('../database');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAction } = require('../services/audit');
const { notifyStakeholders, createNotification } = require('../services/notifications');

const router = express.Router();

// List proposals (with filtering)
router.get('/', authenticate, (req, res) => {
  const { contract_id, status, proposer_id, section_id, search, date_from, date_to } = req.query;
  const db = getDb();

  let query = `
    SELECT p.*, u.full_name as proposer_name, u.role as proposer_role,
      cs.section_number, cs.title as section_title,
      c.title as contract_title,
      (SELECT COUNT(*) FROM feedback f WHERE f.proposal_id = p.id) as feedback_count,
      (SELECT COUNT(*) FROM approvals a WHERE a.proposal_id = p.id AND a.decision = 'approved') as approval_count,
      (SELECT COUNT(*) FROM approvals a WHERE a.proposal_id = p.id AND a.decision = 'rejected') as rejection_count,
      (SELECT COUNT(*) FROM approvals a WHERE a.proposal_id = p.id AND a.required = 1 AND a.decision = 'pending') as pending_required_count
    FROM proposals p
    LEFT JOIN users u ON p.proposer_id = u.id
    LEFT JOIN contract_sections cs ON p.section_id = cs.id
    LEFT JOIN contracts c ON p.contract_id = c.id
    WHERE 1=1
  `;
  const params = [];

  if (contract_id) { query += ' AND p.contract_id = ?'; params.push(contract_id); }
  if (status) { query += ' AND p.status = ?'; params.push(status); }
  if (proposer_id) { query += ' AND p.proposer_id = ?'; params.push(proposer_id); }
  if (section_id) { query += ' AND p.section_id = ?'; params.push(section_id); }
  if (search) { query += ' AND (p.title LIKE ? OR p.original_text LIKE ? OR p.proposed_text LIKE ? OR p.rationale LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
  if (date_from) { query += ' AND p.created_at >= ?'; params.push(date_from); }
  if (date_to) { query += ' AND p.created_at <= ?'; params.push(date_to); }

  query += ' ORDER BY p.updated_at DESC';

  const proposals = db.prepare(query).all(...params);
  res.json(proposals);
});

// Get single proposal with feedback and approvals
router.get('/:id', authenticate, (req, res) => {
  const db = getDb();
  const proposal = db.prepare(`
    SELECT p.*, u.full_name as proposer_name, u.role as proposer_role,
      cs.section_number, cs.title as section_title,
      c.title as contract_title
    FROM proposals p
    LEFT JOIN users u ON p.proposer_id = u.id
    LEFT JOIN contract_sections cs ON p.section_id = cs.id
    LEFT JOIN contracts c ON p.contract_id = c.id
    WHERE p.id = ?
  `).get(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  const feedback = db.prepare(`
    SELECT f.*, u.full_name as commenter_name, u.role as commenter_role
    FROM feedback f
    LEFT JOIN users u ON f.commenter_id = u.id
    WHERE f.proposal_id = ?
    ORDER BY f.created_at ASC
  `).all(req.params.id);

  const approvals = db.prepare(`
    SELECT a.*, u.full_name as reviewer_name, u.role as reviewer_role
    FROM approvals a
    LEFT JOIN users u ON a.reviewer_id = u.id
    WHERE a.proposal_id = ?
    ORDER BY a.required DESC, a.created_at ASC
  `).all(req.params.id);

  // Detect conflicts
  const conflicts = db.prepare(`
    SELECT p.id, p.title, p.status, u.full_name as proposer_name
    FROM proposals p
    LEFT JOIN users u ON p.proposer_id = u.id
    WHERE p.section_id = ? AND p.id != ? AND p.status IN ('draft', 'under_review')
  `).all(proposal.section_id, req.params.id);

  res.json({ ...proposal, feedback, approvals, conflicts });
});

// Create proposal
router.post('/', authenticate, requireRole('admin', 'editor'), (req, res) => {
  const { contract_id, section_id, title, original_text, proposed_text, rationale, priority, bundle_id } = req.body;
  if (!contract_id || !title || !original_text || !proposed_text) {
    return res.status(400).json({ error: 'contract_id, title, original_text, and proposed_text are required' });
  }

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO proposals (contract_id, section_id, title, original_text, proposed_text, rationale, proposer_id, priority, bundle_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(contract_id, section_id || null, title, original_text, proposed_text, rationale || '', req.user.id, priority || 'medium', bundle_id || null);

  logAction(req.user.id, 'create_proposal', 'proposal', result.lastInsertRowid, { title });
  notifyStakeholders(req.user.id, 'new_proposal', 'New Amendment Proposal', `"${title}" has been proposed by ${req.user.full_name}`, 'proposal', result.lastInsertRowid);

  res.status(201).json({ id: result.lastInsertRowid });
});

// Update proposal
router.put('/:id', authenticate, (req, res) => {
  const db = getDb();
  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

  if (proposal.proposer_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the proposer or admin can edit' });
  }

  const { title, proposed_text, rationale, priority, status } = req.body;
  const updates = [];
  const params = [];

  if (title !== undefined) { updates.push('title = ?'); params.push(title); }
  if (proposed_text !== undefined) { updates.push('proposed_text = ?'); params.push(proposed_text); }
  if (rationale !== undefined) { updates.push('rationale = ?'); params.push(rationale); }
  if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
  if (status !== undefined) { updates.push('status = ?'); params.push(status); }

  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);

  db.prepare(`UPDATE proposals SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  logAction(req.user.id, 'update_proposal', 'proposal', Number(req.params.id), { status });

  if (status && status !== proposal.status) {
    notifyStakeholders(req.user.id, 'proposal_status_change', 'Proposal Status Changed',
      `"${proposal.title}" status changed to ${status}`, 'proposal', Number(req.params.id));
  }

  res.json({ message: 'Proposal updated' });
});

// Submit proposal for review
router.post('/:id/submit', authenticate, (req, res) => {
  const db = getDb();
  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
  if (proposal.status !== 'draft') return res.status(400).json({ error: 'Only draft proposals can be submitted' });

  db.prepare("UPDATE proposals SET status = 'under_review', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);

  // Auto-assign required approvers if specified
  const { required_reviewers } = req.body;
  if (required_reviewers && Array.isArray(required_reviewers)) {
    const insertApproval = db.prepare(`
      INSERT OR IGNORE INTO approvals (proposal_id, reviewer_id, required) VALUES (?, ?, 1)
    `);
    for (const reviewerId of required_reviewers) {
      insertApproval.run(req.params.id, reviewerId);
      createNotification(reviewerId, 'review_requested', 'Review Requested',
        `You have been asked to review "${proposal.title}"`, 'proposal', Number(req.params.id));
    }
  }

  logAction(req.user.id, 'submit_proposal', 'proposal', Number(req.params.id));
  notifyStakeholders(req.user.id, 'proposal_submitted', 'Proposal Submitted for Review',
    `"${proposal.title}" is now under review`, 'proposal', Number(req.params.id));

  res.json({ message: 'Proposal submitted for review' });
});

// Apply approved proposal to contract
router.post('/:id/apply', authenticate, requireRole('admin', 'editor'), (req, res) => {
  const db = getDb();
  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
  if (proposal.status !== 'approved') return res.status(400).json({ error: 'Only approved proposals can be applied' });

  if (proposal.section_id) {
    db.prepare('UPDATE contract_sections SET content = ? WHERE id = ?').run(proposal.proposed_text, proposal.section_id);
  }

  logAction(req.user.id, 'apply_proposal', 'proposal', Number(req.params.id));
  res.json({ message: 'Proposal applied to contract' });
});

// Delete proposal
router.delete('/:id', authenticate, (req, res) => {
  const db = getDb();
  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
  if (proposal.proposer_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the proposer or admin can delete' });
  }

  db.prepare('DELETE FROM proposals WHERE id = ?').run(req.params.id);
  logAction(req.user.id, 'delete_proposal', 'proposal', Number(req.params.id));
  res.json({ message: 'Proposal deleted' });
});

// Amendment bundles
router.get('/bundles/list', authenticate, (req, res) => {
  const db = getDb();
  const { contract_id } = req.query;
  let query = `
    SELECT ab.*, u.full_name as created_by_name,
      (SELECT COUNT(*) FROM proposals p WHERE p.bundle_id = ab.id) as proposal_count
    FROM amendment_bundles ab
    LEFT JOIN users u ON ab.created_by = u.id
  `;
  const params = [];
  if (contract_id) { query += ' WHERE ab.contract_id = ?'; params.push(contract_id); }
  query += ' ORDER BY ab.created_at DESC';
  res.json(db.prepare(query).all(...params));
});

router.post('/bundles', authenticate, requireRole('admin', 'editor'), (req, res) => {
  const { contract_id, title, description } = req.body;
  if (!contract_id || !title) return res.status(400).json({ error: 'contract_id and title required' });
  const db = getDb();
  const result = db.prepare('INSERT INTO amendment_bundles (contract_id, title, description, created_by) VALUES (?, ?, ?, ?)').run(contract_id, title, description || '', req.user.id);
  res.status(201).json({ id: result.lastInsertRowid });
});

// Amendment templates
router.get('/templates/list', authenticate, (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM amendment_templates ORDER BY category, name').all());
});

module.exports = router;
