const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../database');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAction } = require('../services/audit');
const { notifyStakeholders } = require('../services/notifications');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.pdf', '.docx', '.doc', '.txt'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOCX, DOC, and TXT files are allowed'));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 }
});

// List contracts
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const contracts = db.prepare(`
    SELECT c.*, u.full_name as created_by_name,
      (SELECT COUNT(*) FROM proposals p WHERE p.contract_id = c.id) as proposal_count,
      (SELECT COUNT(*) FROM contract_versions v WHERE v.contract_id = c.id) as version_count
    FROM contracts c
    LEFT JOIN users u ON c.created_by = u.id
    ORDER BY c.updated_at DESC
  `).all();
  res.json(contracts);
});

// Get single contract with sections
router.get('/:id', authenticate, (req, res) => {
  const db = getDb();
  const contract = db.prepare(`
    SELECT c.*, u.full_name as created_by_name
    FROM contracts c
    LEFT JOIN users u ON c.created_by = u.id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!contract) return res.status(404).json({ error: 'Contract not found' });

  const sections = db.prepare(`
    SELECT * FROM contract_sections WHERE contract_id = ? ORDER BY sort_order, section_number
  `).all(req.params.id);

  const versions = db.prepare(`
    SELECT cv.*, u.full_name as created_by_name
    FROM contract_versions cv
    LEFT JOIN users u ON cv.created_by = u.id
    WHERE cv.contract_id = ?
    ORDER BY cv.version_number DESC
  `).all(req.params.id);

  res.json({ ...contract, sections, versions });
});

// Create contract with file upload
router.post('/', authenticate, requireRole('admin', 'editor'), upload.single('file'), async (req, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const db = getDb();
  let filePath = null;
  let fileType = null;
  let originalFilename = null;
  let extractedText = '';

  if (req.file) {
    filePath = req.file.filename;
    fileType = path.extname(req.file.originalname).toLowerCase().slice(1);
    originalFilename = req.file.originalname;

    try {
      extractedText = await extractTextFromFile(req.file.path, fileType);
    } catch (err) {
      console.error('Text extraction error:', err.message);
    }
  }

  // Allow manual sections via JSON body
  let manualSections = [];
  if (req.body.sections) {
    try {
      manualSections = JSON.parse(req.body.sections);
    } catch (e) { /* ignore parse errors */ }
  }

  const result = db.prepare(`
    INSERT INTO contracts (title, description, original_filename, file_path, file_type, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(title, description || '', originalFilename, filePath, fileType, req.user.id);

  const contractId = result.lastInsertRowid;

  // Parse and insert sections
  const sections = manualSections.length > 0 ? manualSections : parseTextIntoSections(extractedText);
  const insertSection = db.prepare(`
    INSERT INTO contract_sections (contract_id, section_number, title, content, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < sections.length; i++) {
    insertSection.run(contractId, sections[i].number || String(i + 1), sections[i].title || '', sections[i].content, i);
  }

  // Create initial version
  const fullText = sections.map(s => `${s.number || i + 1}. ${s.title || ''}\n${s.content}`).join('\n\n');
  db.prepare(`
    INSERT INTO contract_versions (contract_id, version_number, version_label, change_summary, full_text, sections_snapshot, created_by)
    VALUES (?, 1, 'Original', 'Initial version', ?, ?, ?)
  `).run(contractId, fullText, JSON.stringify(sections), req.user.id);

  logAction(req.user.id, 'create_contract', 'contract', contractId, { title });
  notifyStakeholders(req.user.id, 'contract_created', 'New Contract', `Contract "${title}" has been created`, 'contract', contractId);

  res.status(201).json({ id: contractId, title });
});

// Update contract sections
router.put('/:id/sections', authenticate, requireRole('admin', 'editor'), (req, res) => {
  const { sections } = req.body;
  if (!sections || !Array.isArray(sections)) {
    return res.status(400).json({ error: 'Sections array required' });
  }

  const db = getDb();
  const contract = db.prepare('SELECT id FROM contracts WHERE id = ?').get(req.params.id);
  if (!contract) return res.status(404).json({ error: 'Contract not found' });

  // Delete existing sections and re-insert
  db.prepare('DELETE FROM contract_sections WHERE contract_id = ?').run(req.params.id);

  const insertSection = db.prepare(`
    INSERT INTO contract_sections (contract_id, section_number, title, content, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < sections.length; i++) {
    insertSection.run(req.params.id, sections[i].number || String(i + 1), sections[i].title || '', sections[i].content, i);
  }

  db.prepare('UPDATE contracts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  logAction(req.user.id, 'update_sections', 'contract', Number(req.params.id));

  res.json({ message: 'Sections updated' });
});

// Create new version
router.post('/:id/versions', authenticate, requireRole('admin', 'editor'), (req, res) => {
  const { version_label, change_summary, branch_name } = req.body;
  const db = getDb();

  const contract = db.prepare('SELECT id FROM contracts WHERE id = ?').get(req.params.id);
  if (!contract) return res.status(404).json({ error: 'Contract not found' });

  const lastVersion = db.prepare(
    'SELECT MAX(version_number) as max_ver FROM contract_versions WHERE contract_id = ?'
  ).get(req.params.id);

  const sections = db.prepare(
    'SELECT * FROM contract_sections WHERE contract_id = ? ORDER BY sort_order'
  ).all(req.params.id);

  const fullText = sections.map(s => `${s.section_number}. ${s.title || ''}\n${s.content}`).join('\n\n');
  const newVersion = (lastVersion.max_ver || 0) + 1;

  const result = db.prepare(`
    INSERT INTO contract_versions (contract_id, version_number, version_label, change_summary, full_text, sections_snapshot, created_by, branch_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, newVersion, version_label || `Version ${newVersion}`, change_summary || '', fullText, JSON.stringify(sections), req.user.id, branch_name || 'main');

  logAction(req.user.id, 'create_version', 'contract', Number(req.params.id), { version: newVersion });

  res.status(201).json({ id: result.lastInsertRowid, version_number: newVersion });
});

// Get version details
router.get('/:id/versions/:versionId', authenticate, (req, res) => {
  const db = getDb();
  const version = db.prepare(`
    SELECT cv.*, u.full_name as created_by_name
    FROM contract_versions cv
    LEFT JOIN users u ON cv.created_by = u.id
    WHERE cv.id = ? AND cv.contract_id = ?
  `).get(req.params.versionId, req.params.id);
  if (!version) return res.status(404).json({ error: 'Version not found' });
  res.json(version);
});

// Compare two versions
router.get('/:id/compare', authenticate, (req, res) => {
  const { v1, v2 } = req.query;
  if (!v1 || !v2) return res.status(400).json({ error: 'Both v1 and v2 version IDs required' });

  const db = getDb();
  const version1 = db.prepare('SELECT * FROM contract_versions WHERE id = ? AND contract_id = ?').get(v1, req.params.id);
  const version2 = db.prepare('SELECT * FROM contract_versions WHERE id = ? AND contract_id = ?').get(v2, req.params.id);

  if (!version1 || !version2) return res.status(404).json({ error: 'Version not found' });

  const Diff = require('diff');
  const diff = Diff.diffWords(version1.full_text || '', version2.full_text || '');

  let sections1 = [];
  let sections2 = [];
  try { sections1 = JSON.parse(version1.sections_snapshot || '[]'); } catch (e) {}
  try { sections2 = JSON.parse(version2.sections_snapshot || '[]'); } catch (e) {}

  const sectionDiffs = [];
  const maxLen = Math.max(sections1.length, sections2.length);
  for (let i = 0; i < maxLen; i++) {
    const s1 = sections1[i];
    const s2 = sections2[i];
    sectionDiffs.push({
      section_number: (s2 && s2.section_number) || (s1 && s1.section_number) || String(i + 1),
      title: (s2 && s2.title) || (s1 && s1.title) || '',
      original: s1 ? s1.content : '',
      modified: s2 ? s2.content : '',
      diff: Diff.diffWords(s1 ? s1.content : '', s2 ? s2.content : '')
    });
  }

  res.json({
    version1: { id: version1.id, version_number: version1.version_number, version_label: version1.version_label, created_at: version1.created_at },
    version2: { id: version2.id, version_number: version2.version_number, version_label: version2.version_label, created_at: version2.created_at },
    diff,
    sectionDiffs
  });
});

// Rollback to a version
router.post('/:id/rollback/:versionId', authenticate, requireRole('admin'), (req, res) => {
  const db = getDb();
  const version = db.prepare('SELECT * FROM contract_versions WHERE id = ? AND contract_id = ?').get(req.params.versionId, req.params.id);
  if (!version) return res.status(404).json({ error: 'Version not found' });

  let sections = [];
  try { sections = JSON.parse(version.sections_snapshot || '[]'); } catch (e) {}

  // Replace current sections
  db.prepare('DELETE FROM contract_sections WHERE contract_id = ?').run(req.params.id);
  const insertSection = db.prepare(`
    INSERT INTO contract_sections (contract_id, section_number, title, content, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < sections.length; i++) {
    insertSection.run(req.params.id, sections[i].section_number || String(i + 1), sections[i].title || '', sections[i].content, i);
  }

  // Create a new version marking the rollback
  const lastVersion = db.prepare('SELECT MAX(version_number) as max_ver FROM contract_versions WHERE contract_id = ?').get(req.params.id);
  const newVersion = (lastVersion.max_ver || 0) + 1;
  db.prepare(`
    INSERT INTO contract_versions (contract_id, version_number, version_label, change_summary, full_text, sections_snapshot, created_by, parent_version_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, newVersion, `Rollback to v${version.version_number}`, `Rolled back to version ${version.version_number} (${version.version_label || ''})`, version.full_text, version.sections_snapshot, req.user.id, version.id);

  logAction(req.user.id, 'rollback', 'contract', Number(req.params.id), { to_version: version.version_number });

  res.json({ message: 'Rolled back successfully', new_version: newVersion });
});

// Delete contract
router.delete('/:id', authenticate, requireRole('admin'), (req, res) => {
  const db = getDb();
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
  if (!contract) return res.status(404).json({ error: 'Contract not found' });

  db.prepare('DELETE FROM contracts WHERE id = ?').run(req.params.id);

  if (contract.file_path) {
    const filePath = path.join(__dirname, '..', 'uploads', contract.file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  logAction(req.user.id, 'delete_contract', 'contract', Number(req.params.id), { title: contract.title });
  res.json({ message: 'Contract deleted' });
});

// Helper: extract text from uploaded files
async function extractTextFromFile(filePath, fileType) {
  if (fileType === 'pdf') {
    const pdfParse = require('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  } else if (fileType === 'docx' || fileType === 'doc') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  } else if (fileType === 'txt') {
    return fs.readFileSync(filePath, 'utf-8');
  }
  return '';
}

// Helper: parse raw text into sections
function parseTextIntoSections(text) {
  if (!text || !text.trim()) return [{ number: '1', title: 'Main Content', content: text || '' }];

  const lines = text.split('\n');
  const sections = [];
  let currentSection = null;
  const sectionPattern = /^(\d+(?:\.\d+)*)[.\s)]\s*(.+)/;

  for (const line of lines) {
    const match = line.match(sectionPattern);
    if (match && match[2].trim().length > 0 && match[2].trim().length < 200) {
      if (currentSection) sections.push(currentSection);
      currentSection = { number: match[1], title: match[2].trim(), content: '' };
    } else if (currentSection) {
      currentSection.content += (currentSection.content ? '\n' : '') + line;
    } else {
      currentSection = { number: '1', title: 'Preamble', content: line };
    }
  }
  if (currentSection) sections.push(currentSection);

  if (sections.length === 0) {
    sections.push({ number: '1', title: 'Main Content', content: text });
  }

  return sections;
}

module.exports = router;
