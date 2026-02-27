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
  try {
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
        extractedText = { text: '', html: null, type: fileType };
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

    // Store the contract as a single section.  For DOCX files we use the
    // mammoth HTML which preserves headings, bold text, and numbered lists
    // so the document renders with its original formatting.
    let sections;
    try {
      if (manualSections.length > 0) {
        sections = manualSections;
      } else if (extractedText.type === 'docx' && extractedText.html) {
        console.log('[Parser] Using mammoth HTML for formatted display');
        sections = [{ number: '1', title: 'Full Contract', content: extractedText.html }];
      } else {
        sections = [{ number: '1', title: 'Full Contract', content: extractedText.text || (typeof extractedText === 'string' ? extractedText : '') }];
      }
    } catch (parseErr) {
      console.error('Text extraction error:', parseErr.message, parseErr.stack);
      const fallbackText = extractedText.text || (typeof extractedText === 'string' ? extractedText : '');
      sections = [{ number: '1', title: 'Full Contract', content: fallbackText }];
    }

    const insertSection = db.prepare(`
      INSERT INTO contract_sections (contract_id, section_number, title, content, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < sections.length; i++) {
      insertSection.run(contractId, sections[i].number || String(i + 1), sections[i].title || '', sections[i].content, i);
    }

    // Create initial version
    const fullText = sections.map((s, i) => `${s.number || i + 1}. ${s.title || ''}\n${s.content}`).join('\n\n');
    db.prepare(`
      INSERT INTO contract_versions (contract_id, version_number, version_label, change_summary, full_text, sections_snapshot, created_by)
      VALUES (?, 1, 'Original', 'Initial version', ?, ?, ?)
    `).run(contractId, fullText, JSON.stringify(sections), req.user.id);

    logAction(req.user.id, 'create_contract', 'contract', contractId, { title });
    notifyStakeholders(req.user.id, 'contract_created', 'New Contract', `Contract "${title}" has been created`, 'contract', contractId);

    res.status(201).json({ id: contractId, title });
  } catch (err) {
    console.error('Contract creation error:', err);
    res.status(500).json({ error: 'Failed to create contract: ' + err.message });
  }
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
// For DOCX we extract structured HTML to preserve headings, then fall back to raw text for PDF/TXT
// For DOC (old binary format) we use word-extractor since mammoth only supports DOCX
async function extractTextFromFile(filePath, fileType) {
  if (fileType === 'pdf') {
    const pdfParse = require('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return { text: data.text, html: null, type: 'pdf' };
  } else if (fileType === 'docx') {
    const mammoth = require('mammoth');
    // Get both HTML (preserves heading styles) and raw text
    const [htmlResult, textResult] = await Promise.all([
      mammoth.convertToHtml({ path: filePath }),
      mammoth.extractRawText({ path: filePath })
    ]);
    return { text: textResult.value, html: htmlResult.value, type: 'docx' };
  } else if (fileType === 'doc') {
    // Old binary .doc format — mammoth doesn't support it, use word-extractor
    const WordExtractor = require('word-extractor');
    const extractor = new WordExtractor();
    const doc = await extractor.extract(filePath);
    return { text: doc.getBody(), html: null, type: 'doc' };
  } else if (fileType === 'txt') {
    return { text: fs.readFileSync(filePath, 'utf-8'), html: null, type: 'txt' };
  }
  return { text: '', html: null, type: fileType };
}

// ---- Full-text extraction with Word numbering ----
// Reads the DOCX ZIP directly to compute the exact auto-numbering that Word
// displays, then returns the entire document as a single formatted string.
// Each numbered paragraph is prefixed with its computed number (e.g. "1.2.1").
// Non-numbered paragraphs appear as-is.  The result preserves the exact
// reading order of the document so the user sees the contract as written.
async function extractFullTextWithNumbering(filePath) {
  let JSZip, DOMParser;
  try {
    JSZip = require('jszip');
    DOMParser = require('@xmldom/xmldom').DOMParser;
  } catch (err) {
    console.error('extractFullTextWithNumbering: missing dependency:', err.message);
    return null;
  }

  let zip;
  try {
    const data = fs.readFileSync(filePath);
    zip = await JSZip.loadAsync(data);
  } catch (err) {
    console.error('extractFullTextWithNumbering: failed to read DOCX ZIP:', err.message);
    return null;
  }

  const parser = new DOMParser();

  // ---- 1. Parse numbering.xml ----
  const numXmlStr = await zip.file('word/numbering.xml')?.async('string');
  const numDoc = numXmlStr ? parser.parseFromString(numXmlStr, 'text/xml') : null;

  const abstractDefs = {};
  if (numDoc) {
    const abstractNums = numDoc.getElementsByTagName('w:abstractNum');
    for (let i = 0; i < abstractNums.length; i++) {
      const an = abstractNums[i];
      const id = an.getAttribute('w:abstractNumId');
      const levels = {};
      for (let c = an.firstChild; c; c = c.nextSibling) {
        if (c.nodeName !== 'w:lvl') continue;
        const ilvl = parseInt(c.getAttribute('w:ilvl'), 10);
        const startEl = getDirectChild(c, 'w:start');
        const fmtEl = getDirectChild(c, 'w:numFmt');
        const txtEl = getDirectChild(c, 'w:lvlText');
        levels[ilvl] = {
          start: parseInt(startEl?.getAttribute('w:val') || '1', 10),
          numFmt: fmtEl?.getAttribute('w:val') || 'decimal',
          lvlText: txtEl?.getAttribute('w:val') || ''
        };
      }
      abstractDefs[id] = { levels };
    }
  }

  const numDefs = {};
  if (numDoc) {
    const nums = numDoc.getElementsByTagName('w:num');
    for (let i = 0; i < nums.length; i++) {
      const num = nums[i];
      const numId = num.getAttribute('w:numId');
      const abstractRefEl = getDirectChild(num, 'w:abstractNumId');
      const abstractRef = abstractRefEl?.getAttribute('w:val');
      if (!abstractRef || !abstractDefs[abstractRef]) continue;
      const levels = {};
      for (const [lvl, def] of Object.entries(abstractDefs[abstractRef].levels)) {
        levels[lvl] = { ...def };
      }
      for (let c = num.firstChild; c; c = c.nextSibling) {
        if (c.nodeName !== 'w:lvlOverride') continue;
        const ilvl = parseInt(c.getAttribute('w:ilvl'), 10);
        const startOvr = getDirectChild(c, 'w:startOverride');
        if (startOvr && levels[ilvl]) {
          levels[ilvl].start = parseInt(startOvr.getAttribute('w:val'), 10);
        }
      }
      numDefs[numId] = { levels };
    }
  }

  // ---- 2. Parse styles.xml for style-based numbering ----
  const styleNumMap = {};
  const stylesXmlStr = await zip.file('word/styles.xml')?.async('string');
  if (stylesXmlStr) {
    const stylesDoc = parser.parseFromString(stylesXmlStr, 'text/xml');
    const styles = stylesDoc.getElementsByTagName('w:style');
    for (let i = 0; i < styles.length; i++) {
      const style = styles[i];
      const styleId = style.getAttribute('w:styleId');
      const pPr = getDirectChild(style, 'w:pPr');
      if (!pPr) continue;
      const numPr = getDirectChild(pPr, 'w:numPr');
      if (!numPr) continue;
      const numIdEl = getDirectChild(numPr, 'w:numId');
      const ilvlEl = getDirectChild(numPr, 'w:ilvl');
      if (numIdEl) {
        styleNumMap[styleId] = {
          numId: numIdEl.getAttribute('w:val'),
          ilvl: parseInt(ilvlEl?.getAttribute('w:val') || '0', 10)
        };
      }
    }
  }

  // ---- 3. Parse document.xml and build formatted text ----
  const docXmlStr = await zip.file('word/document.xml')?.async('string');
  if (!docXmlStr) return null;

  const docDoc = parser.parseFromString(docXmlStr, 'text/xml');
  const pElements = docDoc.getElementsByTagName('w:p');

  const counters = {};
  const lines = [];

  function formatNumber(val, fmt) {
    switch (fmt) {
      case 'upperRoman': return toRoman(val);
      case 'lowerRoman': return toRoman(val).toLowerCase();
      case 'upperLetter': return val > 0 && val <= 26 ? String.fromCharCode(64 + val) : String(val);
      case 'lowerLetter': return val > 0 && val <= 26 ? String.fromCharCode(96 + val) : String(val);
      case 'decimal': default: return String(val);
    }
  }

  function toRoman(num) {
    const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
    const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
    let result = '';
    for (let i = 0; i < vals.length; i++) {
      while (num >= vals[i]) { result += syms[i]; num -= vals[i]; }
    }
    return result;
  }

  function computeNumberText(numId, level) {
    const def = numDefs[numId];
    if (!def) return '';
    const lvlDef = def.levels[level];
    if (!lvlDef || lvlDef.numFmt === 'bullet' || lvlDef.numFmt === 'none') return '';
    let text = lvlDef.lvlText;
    for (let l = 0; l <= level; l++) {
      const val = counters[numId]?.[l] || 0;
      const fmt = def.levels[l]?.numFmt || 'decimal';
      text = text.replace('%' + (l + 1), formatNumber(val, fmt));
    }
    return text;
  }

  for (let i = 0; i < pElements.length; i++) {
    const p = pElements[i];

    // Get text
    let text = '';
    const runs = p.getElementsByTagName('w:t');
    for (let j = 0; j < runs.length; j++) {
      text += runs[j].textContent || '';
    }
    text = text.trim();

    // Resolve numbering
    let numId = null, ilvl = null;
    const pPr = getDirectChild(p, 'w:pPr');
    if (pPr) {
      const numPr = getDirectChild(pPr, 'w:numPr');
      if (numPr) {
        const numIdEl = getDirectChild(numPr, 'w:numId');
        const ilvlEl = getDirectChild(numPr, 'w:ilvl');
        if (numIdEl) {
          numId = numIdEl.getAttribute('w:val');
          ilvl = parseInt(ilvlEl?.getAttribute('w:val') || '0', 10);
        }
      }
      if (!numId) {
        const pStyleEl = getDirectChild(pPr, 'w:pStyle');
        if (pStyleEl) {
          const sid = pStyleEl.getAttribute('w:val');
          if (styleNumMap[sid]) {
            numId = styleNumMap[sid].numId;
            ilvl = styleNumMap[sid].ilvl;
          }
        }
      }
    }
    if (numId === '0') { numId = null; ilvl = null; }

    // Compute number prefix
    let prefix = '';
    if (numId && numDefs[numId]) {
      const def = numDefs[numId];
      const level = ilvl ?? 0;
      const fmt = def.levels[level]?.numFmt;

      if (fmt === 'bullet') {
        prefix = '  '.repeat(level) + '• ';
      } else if (fmt === 'none') {
        // no prefix
      } else {
        if (!counters[numId]) {
          counters[numId] = {};
          for (const [lvl, lvlDef] of Object.entries(def.levels)) {
            counters[numId][lvl] = lvlDef.start - 1;
          }
        }
        const ctr = counters[numId];
        if (ctr[level] === undefined) ctr[level] = (def.levels[level]?.start || 1) - 1;
        ctr[level]++;
        for (const lvl of Object.keys(ctr)) {
          if (parseInt(lvl, 10) > level) {
            ctr[lvl] = (def.levels[lvl]?.start || 1) - 1;
          }
        }
        const numText = computeNumberText(numId, level);
        // Indent sub-levels for readability
        const indent = '  '.repeat(level);
        prefix = indent + numText + ' ';
      }
    }

    if (text || lines.length > 0) {
      // Blank lines → paragraph break
      if (!text) {
        lines.push('');
      } else {
        lines.push(prefix + text);
      }
    }
  }

  // Collapse runs of 3+ blank lines down to 2
  const result = lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
  return result || null;
}

// ---- Section Parsing Engine ----

// Primary parser for DOCX: reads the DOCX ZIP directly to compute the exact
// numbering that Word displays. This parses word/numbering.xml for numbering
// definitions (format, start values, level text like "%1.%2.%3.") and
// word/document.xml for each paragraph's numId and ilvl, then walks through
// paragraphs in order maintaining counters per level to produce the exact
// same numbers the user sees in Word.
async function parseSectionsFromDocxXml(filePath) {
  let JSZip, DOMParser;
  try {
    JSZip = require('jszip');
    DOMParser = require('@xmldom/xmldom').DOMParser;
  } catch (err) {
    console.error('parseSectionsFromDocxXml: missing dependency:', err.message);
    return null;
  }

  let zip;
  try {
    const data = fs.readFileSync(filePath);
    zip = await JSZip.loadAsync(data);
  } catch (err) {
    console.error('parseSectionsFromDocxXml: failed to read DOCX ZIP:', err.message);
    return null;
  }

  const parser = new DOMParser();
  const log = []; // debug log
  function dbg(msg) { log.push(msg); console.log('[DOCX-Parse] ' + msg); }

  // ---- 1. Parse numbering.xml ----
  const numXmlStr = await zip.file('word/numbering.xml')?.async('string');
  // numbering.xml is optional — documents can use heading styles without numbering
  const numDoc = numXmlStr ? parser.parseFromString(numXmlStr, 'text/xml') : null;

  // Build abstract numbering definitions
  const abstractDefs = {};
  if (numDoc) {
    const abstractNums = numDoc.getElementsByTagName('w:abstractNum');
    for (let i = 0; i < abstractNums.length; i++) {
      const an = abstractNums[i];
      const id = an.getAttribute('w:abstractNumId');
      const levels = {};
      for (let c = an.firstChild; c; c = c.nextSibling) {
        if (c.nodeName !== 'w:lvl') continue;
        const ilvl = parseInt(c.getAttribute('w:ilvl'), 10);
        const startEl = getDirectChild(c, 'w:start');
        const fmtEl = getDirectChild(c, 'w:numFmt');
        const txtEl = getDirectChild(c, 'w:lvlText');
        levels[ilvl] = {
          start: parseInt(startEl?.getAttribute('w:val') || '1', 10),
          numFmt: fmtEl?.getAttribute('w:val') || 'decimal',
          lvlText: txtEl?.getAttribute('w:val') || ''
        };
      }
      abstractDefs[id] = { levels };
      dbg(`abstractNum[${id}]: ${Object.entries(levels).map(([l,d]) => `L${l}=${d.numFmt} "${d.lvlText}" start=${d.start}`).join(', ')}`);
    }
  }

  // Build num → abstractNum mapping with overrides
  const numDefs = {};
  if (numDoc) {
    const nums = numDoc.getElementsByTagName('w:num');
    for (let i = 0; i < nums.length; i++) {
      const num = nums[i];
      const numId = num.getAttribute('w:numId');
      const abstractRefEl = getDirectChild(num, 'w:abstractNumId');
      const abstractRef = abstractRefEl?.getAttribute('w:val');
      if (!abstractRef || !abstractDefs[abstractRef]) continue;

      // Clone levels from abstract definition
      const levels = {};
      for (const [lvl, def] of Object.entries(abstractDefs[abstractRef].levels)) {
        levels[lvl] = { ...def };
      }

      // Apply level overrides
      const overrides = [];
      for (let c = num.firstChild; c; c = c.nextSibling) {
        if (c.nodeName !== 'w:lvlOverride') continue;
        const ilvl = parseInt(c.getAttribute('w:ilvl'), 10);
        const startOvr = getDirectChild(c, 'w:startOverride');
        if (startOvr && levels[ilvl]) {
          levels[ilvl].start = parseInt(startOvr.getAttribute('w:val'), 10);
          overrides.push(`L${ilvl}→start=${levels[ilvl].start}`);
        }
      }

      numDefs[numId] = { levels, abstractRef };
      if (overrides.length) dbg(`num[${numId}] → abstract[${abstractRef}] overrides: ${overrides.join(', ')}`);
    }
  }

  // ---- 2. Parse styles.xml for style-based numbering and heading styles ----
  const styleNumMap = {}; // styleName -> { numId, ilvl }
  const styleOutlineLevel = {}; // styleName -> outlineLevel (0-8, where 0 = Heading 1)
  const styleNameMap = {}; // styleId -> display name
  const stylesXmlStr = await zip.file('word/styles.xml')?.async('string');
  if (stylesXmlStr) {
    const stylesDoc = parser.parseFromString(stylesXmlStr, 'text/xml');
    const styles = stylesDoc.getElementsByTagName('w:style');
    for (let i = 0; i < styles.length; i++) {
      const style = styles[i];
      const styleId = style.getAttribute('w:styleId');
      const nameEl = getDirectChild(style, 'w:name');
      const styleName = nameEl?.getAttribute('w:val') || styleId;
      styleNameMap[styleId] = styleName;

      const pPr = getDirectChild(style, 'w:pPr');
      if (!pPr) continue;

      // Check for outline level (heading styles)
      const outlineLvlEl = getDirectChild(pPr, 'w:outlineLvl');
      if (outlineLvlEl) {
        styleOutlineLevel[styleId] = parseInt(outlineLvlEl.getAttribute('w:val'), 10);
      }

      // Check for numbering reference
      const numPr = getDirectChild(pPr, 'w:numPr');
      if (!numPr) continue;
      const numIdEl = getDirectChild(numPr, 'w:numId');
      const ilvlEl = getDirectChild(numPr, 'w:ilvl');
      if (numIdEl) {
        styleNumMap[styleId] = {
          numId: numIdEl.getAttribute('w:val'),
          ilvl: parseInt(ilvlEl?.getAttribute('w:val') || '0', 10)
        };
        dbg(`style[${styleId}] "${styleName}" → numId=${styleNumMap[styleId].numId} ilvl=${styleNumMap[styleId].ilvl}`);
      }
    }
  }

  // Also map common heading style names to outline levels
  for (const [sid, name] of Object.entries(styleNameMap)) {
    if (styleOutlineLevel[sid] === undefined) {
      const m = name.match(/^heading\s*(\d)$/i);
      if (m) styleOutlineLevel[sid] = parseInt(m[1], 10) - 1;
    }
  }

  // ---- 3. Parse document.xml ----
  const docXmlStr = await zip.file('word/document.xml')?.async('string');
  if (!docXmlStr) return null;

  const docDoc = parser.parseFromString(docXmlStr, 'text/xml');
  const pElements = docDoc.getElementsByTagName('w:p');

  // Extract paragraph data
  const paragraphs = [];
  for (let i = 0; i < pElements.length; i++) {
    const p = pElements[i];

    // Get text content from all runs
    let text = '';
    const runs = p.getElementsByTagName('w:t');
    for (let j = 0; j < runs.length; j++) {
      text += runs[j].textContent || '';
    }
    text = text.trim();

    // Check for bold formatting
    let isBold = false;
    const rElements = p.getElementsByTagName('w:r');
    if (rElements.length > 0) {
      let allRunsBold = true;
      for (let j = 0; j < rElements.length; j++) {
        const rPr = getDirectChild(rElements[j], 'w:rPr');
        const hasBold = rPr && (getDirectChild(rPr, 'w:b') || getDirectChild(rPr, 'w:bCs'));
        if (!hasBold) {
          let runText = '';
          const ts = rElements[j].getElementsByTagName('w:t');
          for (let k = 0; k < ts.length; k++) runText += ts[k].textContent || '';
          if (runText.trim()) { allRunsBold = false; break; }
        }
      }
      isBold = allRunsBold && rElements.length > 0;
    }

    // Get paragraph style
    let pStyleId = null;
    let outlineLevel = null;
    let numId = null, ilvl = null;
    const pPr = getDirectChild(p, 'w:pPr');
    if (pPr) {
      const pStyleEl = getDirectChild(pPr, 'w:pStyle');
      if (pStyleEl) {
        pStyleId = pStyleEl.getAttribute('w:val');
        if (styleOutlineLevel[pStyleId] !== undefined) {
          outlineLevel = styleOutlineLevel[pStyleId];
        }
      }

      // Get explicit numbering
      const numPr = getDirectChild(pPr, 'w:numPr');
      if (numPr) {
        const numIdEl = getDirectChild(numPr, 'w:numId');
        const ilvlEl = getDirectChild(numPr, 'w:ilvl');
        if (numIdEl) {
          numId = numIdEl.getAttribute('w:val');
          ilvl = parseInt(ilvlEl?.getAttribute('w:val') || '0', 10);
        }
      }
      // If no explicit numPr, check if the paragraph style implies numbering
      if (!numId && pStyleId && styleNumMap[pStyleId]) {
        numId = styleNumMap[pStyleId].numId;
        ilvl = styleNumMap[pStyleId].ilvl;
      }

      // Also check paragraph-level outline level
      if (outlineLevel === null) {
        const outEl = getDirectChild(pPr, 'w:outlineLvl');
        if (outEl) outlineLevel = parseInt(outEl.getAttribute('w:val'), 10);
      }
    }

    // Skip numId="0" which means "no numbering"
    if (numId === '0') { numId = null; ilvl = null; }

    paragraphs.push({ text, isBold, numId, ilvl, pStyleId, outlineLevel });
  }

  dbg(`Total paragraphs: ${paragraphs.length}, non-empty: ${paragraphs.filter(p => p.text).length}`);
  dbg(`Paragraphs with numbering: ${paragraphs.filter(p => p.numId).length}`);
  dbg(`Paragraphs with outline levels: ${paragraphs.filter(p => p.outlineLevel !== null).length}`);
  dbg(`Paragraphs that are bold: ${paragraphs.filter(p => p.isBold && p.text).length}`);

  // ---- 4. Classify every paragraph, then assemble sections ----
  // Strategy:
  //   a) Find exhibit/attachment boundaries (bold text matching EXHIBIT, SCHEDULE, etc.)
  //   b) Everything before the first exhibit = one "Preamble" section
  //   c) Each exhibit heading = its own section
  //   d) Numbered items within exhibits = individual sections with exact Word numbering
  //   e) Non-numbered, non-exhibit text appends to the most recent section

  const counters = {}; // { numId: { level: currentCount } }

  function formatNumber(val, fmt) {
    switch (fmt) {
      case 'upperRoman': return toRoman(val);
      case 'lowerRoman': return toRoman(val).toLowerCase();
      case 'upperLetter': return val > 0 && val <= 26 ? String.fromCharCode(64 + val) : String(val);
      case 'lowerLetter': return val > 0 && val <= 26 ? String.fromCharCode(96 + val) : String(val);
      case 'decimal': default: return String(val);
    }
  }

  function toRoman(num) {
    const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
    const syms = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
    let result = '';
    for (let i = 0; i < vals.length; i++) {
      while (num >= vals[i]) { result += syms[i]; num -= vals[i]; }
    }
    return result;
  }

  function computeNumberText(numId, level) {
    const def = numDefs[numId];
    if (!def) return '';
    const lvlDef = def.levels[level];
    if (!lvlDef || lvlDef.numFmt === 'bullet' || lvlDef.numFmt === 'none') return '';

    let text = lvlDef.lvlText;
    for (let l = 0; l <= level; l++) {
      const val = counters[numId]?.[l] || 0;
      const fmt = def.levels[l]?.numFmt || 'decimal';
      text = text.replace('%' + (l + 1), formatNumber(val, fmt));
    }
    return text.replace(/\.+$/, '');
  }

  function makeShortTitle(text) {
    if (!text) return '';
    const firstLine = text.split('\n')[0].trim();
    return firstLine.length <= 120 ? firstLine : firstLine.substring(0, 117) + '...';
  }

  // Detect exhibit/appendix/schedule/SOW headings
  const exhibitRe = /^(EXHIBIT|SCHEDULE|APPENDIX|ANNEX|ATTACHMENT)\s+[A-Z0-9]/i;
  function isExhibitHeading(text) {
    return exhibitRe.test(text.trim());
  }

  // ---- Pass 1: Classify each paragraph ----
  const classified = [];
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi];
    if (!para.text) continue;

    let kind = 'body'; // default: plain body text
    let numberText = '';

    // Check if this is a numbered paragraph
    if (para.numId && numDefs[para.numId]) {
      const def = numDefs[para.numId];
      const level = para.ilvl;
      const fmt = def.levels[level]?.numFmt;
      if (fmt === 'bullet' || fmt === 'none') {
        kind = 'bullet';
      } else {
        // Initialize counters
        if (!counters[para.numId]) {
          counters[para.numId] = {};
          for (const [lvl, lvlDef] of Object.entries(def.levels)) {
            counters[para.numId][lvl] = lvlDef.start - 1;
          }
        }
        const ctr = counters[para.numId];
        if (ctr[level] === undefined) ctr[level] = (def.levels[level]?.start || 1) - 1;
        ctr[level]++;
        for (const lvl of Object.keys(ctr)) {
          if (parseInt(lvl, 10) > level) {
            ctr[lvl] = (def.levels[lvl]?.start || 1) - 1;
          }
        }
        numberText = computeNumberText(para.numId, level);
        kind = 'numbered';
        dbg(`  [${pi}] NUMBERED numId=${para.numId} ilvl=${level} → "${numberText}" | ${para.text.substring(0, 80)}`);
      }
    }

    // Check if exhibit heading (bold, matches exhibit pattern)
    if (kind === 'body' && isExhibitHeading(para.text)) {
      kind = 'exhibit';
      dbg(`  [${pi}] EXHIBIT HEADING | ${para.text.substring(0, 80)}`);
    }
    // Check if heading style
    else if (kind === 'body' && para.outlineLevel !== null && para.outlineLevel <= 8) {
      // Heading styles that match exhibit patterns → exhibit
      if (isExhibitHeading(para.text)) {
        kind = 'exhibit';
        dbg(`  [${pi}] EXHIBIT HEADING (outline) | ${para.text.substring(0, 80)}`);
      } else {
        kind = 'heading';
        dbg(`  [${pi}] HEADING outlineLevel=${para.outlineLevel} | ${para.text.substring(0, 80)}`);
      }
    }
    // Check if bold short text (but NOT an exhibit)
    else if (kind === 'body' && para.isBold && para.text.length <= 200) {
      kind = 'bold';
      dbg(`  [${pi}] BOLD | ${para.text.substring(0, 80)}`);
    }

    classified.push({ ...para, kind, numberText, pi });
  }

  // ---- Pass 2: Find the first exhibit boundary ----
  let firstExhibitIdx = classified.findIndex(c => c.kind === 'exhibit');
  dbg(`First exhibit paragraph index: ${firstExhibitIdx} (of ${classified.length} classified)`);

  // ---- Pass 3: Assemble sections ----
  const sections = [];

  // 3a. Everything before the first exhibit → one "Preamble" section
  if (firstExhibitIdx === -1) firstExhibitIdx = classified.length; // no exhibits at all

  if (firstExhibitIdx > 0) {
    let preambleContent = '';
    for (let i = 0; i < firstExhibitIdx; i++) {
      const c = classified[i];
      if (!c.text) continue;
      // For bold headings in the preamble, include them as bold markers in the content
      if (c.kind === 'bold' || c.kind === 'heading') {
        preambleContent += (preambleContent ? '\n\n' : '') + c.text;
      } else if (c.kind === 'numbered') {
        preambleContent += (preambleContent ? '\n' : '') + (c.numberText ? c.numberText + '. ' : '') + c.text;
      } else if (c.kind === 'bullet') {
        preambleContent += (preambleContent ? '\n' : '') + '- ' + c.text;
      } else {
        preambleContent += (preambleContent ? '\n' : '') + c.text;
      }
    }
    if (preambleContent.trim()) {
      sections.push({
        number: 'Preamble',
        title: 'Amendment Body',
        content: preambleContent.trim()
      });
      dbg(`  Created Preamble section (${preambleContent.length} chars)`);
    }
  }

  // 3b. Process from the first exhibit onward
  for (let i = firstExhibitIdx; i < classified.length; i++) {
    const c = classified[i];

    if (c.kind === 'exhibit') {
      // Exhibit heading → new section
      const parsed = parseNumberFromTitle(c.text);
      sections.push({
        number: parsed.number || c.text,
        title: parsed.title || c.text,
        content: ''
      });
      dbg(`  Created EXHIBIT section: [${parsed.number || c.text}] "${(parsed.title || c.text).substring(0, 60)}"`);
    } else if (c.kind === 'numbered') {
      // Numbered item → individual section with exact numbering
      sections.push({
        number: c.numberText || String(sections.length + 1),
        title: (c.isBold) ? c.text : makeShortTitle(c.text),
        content: (c.isBold) ? '' : c.text
      });
    } else if (c.kind === 'heading') {
      // Heading-styled paragraph within exhibit area
      const parsed = parseNumberFromTitle(c.text);
      sections.push({
        number: parsed.number || String(sections.length + 1),
        title: parsed.title,
        content: ''
      });
    } else if (c.kind === 'bold') {
      // Bold text within exhibit area — could be sub-exhibit heading
      // Check if it looks like a structural heading (EXHIBIT, all-caps short text, etc.)
      if (isExhibitHeading(c.text)) {
        const parsed = parseNumberFromTitle(c.text);
        sections.push({
          number: parsed.number || c.text,
          title: parsed.title || c.text,
          content: ''
        });
      } else {
        // Regular bold text in exhibit area — append to last section
        if (sections.length > 0) {
          const last = sections[sections.length - 1];
          last.content += (last.content ? '\n\n' : '') + c.text;
        }
      }
    } else if (c.kind === 'bullet') {
      if (sections.length > 0) {
        const last = sections[sections.length - 1];
        last.content += (last.content ? '\n' : '') + '- ' + c.text;
      }
    } else {
      // Plain body text → append to last section
      if (sections.length > 0) {
        const last = sections[sections.length - 1];
        last.content += (last.content ? '\n' : '') + c.text;
      }
    }
  }

  dbg(`Final section count: ${sections.length}`);
  for (let i = 0; i < Math.min(sections.length, 80); i++) {
    dbg(`  Section [${sections[i].number}] "${(sections[i].title || '').substring(0, 60)}"`);
  }

  // Save debug log
  try {
    const debugDir = path.join(__dirname, '..', '..', 'data');
    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
    fs.writeFileSync(path.join(debugDir, 'debug_docx_parse.log'), log.join('\n'));
  } catch (e) { /* ignore */ }

  if (sections.length <= 1) return null;
  return sections;
}

// Helper: get a direct child element by name (not searching all descendants)
function getDirectChild(parent, tagName) {
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (c.nodeName === tagName) return c;
  }
  return null;
}

// Fallback HTML parser for DOCX: parse the HTML output from mammoth to detect section boundaries.
// Mammoth converts Word documents to HTML where:
//   - Heading styles → <h1>-<h6>
//   - Bold paragraphs → <p><strong>...</strong></p>
//   - Multi-level numbered lists → nested <ol><li> (e.g. 1., 1.1., 1.2.1.)
// Every numbered clause at every nesting depth becomes its own section so users
// can propose amendments to individual clauses.
function parseSectionsFromHtml(html) {
  let parse;
  try {
    parse = require('node-html-parser').parse;
  } catch (err) {
    console.error('node-html-parser not installed. Run: npm install node-html-parser');
    return null;
  }

  const root = parse(html);
  const sections = [];
  let pendingSection = null;

  // Persists across multiple top-level <ol> blocks so numbering never resets
  let topLevelCounter = 0;

  function pushSection(section) {
    sections.push(section);
    pendingSection = section;
  }

  function appendContent(text) {
    if (!text.trim()) return;
    if (pendingSection) {
      pendingSection.content += (pendingSection.content ? '\n' : '') + text.trim();
    } else {
      pushSection({ number: '0', title: 'Preamble', content: text.trim() });
    }
  }

  // Generate a short title from clause text (first line, max 80 chars)
  function makeTitle(text) {
    if (!text) return '';
    const firstLine = text.split('\n')[0].trim();
    if (firstLine.length <= 80) return firstLine;
    return firstLine.substring(0, 77) + '...';
  }

  // Render a <ul> node as bullet-point text (not sections)
  function ulToText(ul) {
    let text = '';
    for (const child of ul.childNodes) {
      if ((child.tagName || '').toLowerCase() === 'li') {
        text += '\n- ' + liDirectText(child).trim();
      }
    }
    return text;
  }

  // Get ALL direct text from a <li>, excluding nested <ol>/<ul> elements.
  // Bold text IS included (it's content emphasis, not always a heading).
  function liDirectText(li) {
    let text = '';
    for (const child of li.childNodes) {
      const tag = (child.tagName || '').toLowerCase();
      if (tag === 'ol' || tag === 'ul') continue;
      text += child.textContent || child.rawText || '';
    }
    return text.trim();
  }

  // Get the bold title from a <li>, but ONLY when:
  //   1. The first non-whitespace child is <strong>/<b>
  //   2. The <li> also has a nested <ol> (so it's a parent heading, not a leaf)
  // This avoids treating inline bold emphasis as section headings.
  function getLiBoldTitle(li, hasNestedOl) {
    if (!hasNestedOl) return '';
    for (const child of li.childNodes) {
      if (child.nodeType === 3 && !child.rawText.trim()) continue;
      const tag = (child.tagName || '').toLowerCase();
      if (tag === 'strong' || tag === 'b') {
        return child.textContent.trim().replace(/[.\s:]+$/, '');
      }
      break; // first non-whitespace child is not bold
    }
    return '';
  }

  // Recursively process a <li> element at any nesting depth.
  // Creates a section for this <li>, then recurses into any nested <ol>.
  function processLi(li, sectionNumber) {
    const directText = liDirectText(li);

    // Find all nested <ol> and <ul> children
    const nestedOls = [];
    const nestedUls = [];
    for (const child of li.childNodes) {
      const tag = (child.tagName || '').toLowerCase();
      if (tag === 'ol') nestedOls.push(child);
      else if (tag === 'ul') nestedUls.push(child);
    }

    const hasNestedOl = nestedOls.length > 0;
    const boldTitle = getLiBoldTitle(li, hasNestedOl);

    // Determine title and content
    let title, content;
    if (boldTitle) {
      title = boldTitle;
      // Content is everything except the bold title text
      const remaining = directText.replace(boldTitle, '').replace(/^[.\s:]+/, '').trim();
      content = remaining;
    } else {
      title = makeTitle(directText);
      content = directText;
    }

    // Append <ul> content as bullet text (bullets aren't numbered sections)
    for (const ul of nestedUls) {
      const ulText = ulToText(ul).trim();
      if (ulText) {
        content = content ? content + '\n' + ulText : ulText;
      }
    }

    pushSection({
      number: sectionNumber,
      title: title || '(untitled)',
      content: content
    });

    // Recursively process ALL nested <ol> elements.
    // A single counter spans all <ol>s within this <li> so numbering is continuous.
    let childIdx = 0;
    for (const ol of nestedOls) {
      for (const childLi of ol.childNodes) {
        if ((childLi.tagName || '').toLowerCase() !== 'li') continue;
        childIdx++;
        processLi(childLi, `${sectionNumber}.${childIdx}`);
      }
    }
  }

  // Process a top-level <ol> block. Uses topLevelCounter which persists across
  // multiple <ol> blocks so section 4 doesn't get numbered as 1.
  function processTopLevelOl(ol) {
    for (const li of ol.childNodes) {
      if ((li.tagName || '').toLowerCase() !== 'li') continue;
      topLevelCounter++;
      processLi(li, String(topLevelCounter));
    }
  }

  // Walk the top-level children of the document
  for (const node of root.childNodes) {
    const tag = (node.tagName || '').toLowerCase();

    // --- Heading tags (h1-h6): always a section boundary ---
    if (/^h[1-6]$/.test(tag)) {
      const rawTitle = node.textContent.trim();
      if (!rawTitle) continue;
      const parsed = parseNumberFromTitle(rawTitle);
      pushSection({
        number: parsed.number || String(sections.length + 1),
        title: parsed.title,
        content: ''
      });
      continue;
    }

    // --- Bold-only paragraph: treat as section heading ---
    if (tag === 'p') {
      const children = node.childNodes.filter(c => c.nodeType !== 3 || c.rawText.trim());
      const allBold = children.length > 0 && children.every(c => {
        const ct = (c.tagName || '').toLowerCase();
        return ct === 'strong' || ct === 'b' || (c.nodeType === 3 && !c.rawText.trim());
      });
      if (allBold) {
        const innerText = node.textContent.trim();
        if (innerText.length > 0 && innerText.length <= 200) {
          const parsed = parseNumberFromTitle(innerText);
          pushSection({
            number: parsed.number || String(sections.length + 1),
            title: parsed.title,
            content: ''
          });
          continue;
        }
      }
      // Regular paragraph — append as content
      appendContent(node.textContent);
      continue;
    }

    // --- Ordered list: recursively expand into individual clause sections ---
    if (tag === 'ol') {
      processTopLevelOl(node);
      continue;
    }

    // --- Anything else: treat as content ---
    if (node.textContent && node.textContent.trim()) {
      appendContent(node.textContent);
    }
  }

  // Quality check: if we only got 1 section, the HTML parsing wasn't helpful
  if (sections.length <= 1) return null;

  return sections;
}

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
    .replace(/<\/li>\s*/gi, '\n')
    .replace(/<li[^>]*>/gi, '  - ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// For plain text (PDF / TXT): use multiple pattern strategies to detect section headers
function parseTextIntoSections(text) {
  if (!text || !text.trim()) return [{ number: '1', title: 'Main Content', content: text || '' }];

  // Normalize line endings and collapse excessive blank lines
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{4,}/g, '\n\n\n');
  const lines = normalized.split('\n');

  // --- Pattern definitions (ordered by specificity) ---
  const patterns = [
    // "ARTICLE I" / "ARTICLE 1" / "Article I." / "Article One"
    { regex: /^(ARTICLE|Article)\s+([IVXLCDM]+|\d+)\.?\s*[-–—:]?\s*(.*)$/i, type: 'article' },
    // "SECTION 1.1" / "Section 3" / "SECTION 10.2.1"
    { regex: /^(SECTION|Section)\s+(\d+(?:\.\d+)*)\.?\s*[-–—:]?\s*(.*)$/i, type: 'section' },
    // "EXHIBIT A" / "EXHIBIT B-1" / "SCHEDULE 1" / "APPENDIX B-2" / "ANNEX 1"
    { regex: /^(EXHIBIT|SCHEDULE|APPENDIX|ANNEX|ATTACHMENT)\s+([A-Z0-9][-A-Z0-9]*)\.?\s*[,.\s]*[-–—:]?\s*(.*)$/i, type: 'exhibit' },
    // Numbered: "1." / "1.1" / "1.1.1" / "12.3" — must be at start of line
    { regex: /^(\d{1,3}(?:\.\d{1,3}){0,4})\.?\s+([A-Z].{0,200})$/, type: 'numbered' },
    // Lettered subsections: "(a)" / "(b)" / "(i)" / "(ii)" — only top-level letters
    { regex: /^\(([a-z]|[ivx]+)\)\s+(.+)$/, type: 'lettered' },
    // Roman numeral sections: "I." / "II." / "III." / "IV." at start of line with title
    { regex: /^([IVXLCDM]{1,6})\.?\s+((?:[A-Z][A-Za-z]*\s*){1,10}.*)$/, type: 'roman' },
    // ALL-CAPS lines (single word 5+ chars or multi-word, max 120 chars) — common for contract headers
    { regex: /^([A-Z][A-Z\s,&\-/]{3,120})$/, type: 'allcaps' },
    // "RECITALS" / "WHEREAS" / "NOW, THEREFORE" / "DEFINITIONS" / "WITNESSETH"
    { regex: /^(RECITALS?|WHEREAS|NOW,?\s*THEREFORE|DEFINITIONS?|WITNESSETH|PREAMBLE|BACKGROUND|TERMS AND CONDITIONS|INDEMNIFICATION|INDEMNITY|CONFIDENTIALITY|MISCELLANEOUS|REPRESENTATIONS|WARRANTIES|COVENANTS|GOVERNING LAW|NOTICES|INSURANCE|FORCE MAJEURE|ASSIGNMENT|SEVERABILITY|AMENDMENTS?|ENTIRE AGREEMENT|COUNTERPARTS|WAIVER|ARBITRATION|DISPUTE RESOLUTION|TERMINATION|INTELLECTUAL PROPERTY)\s*:?\s*$/i, type: 'keyword' },
  ];

  // First pass: identify which lines are headers
  const lineClassifications = lines.map((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return { line: trimmed, isHeader: false, idx };

    for (const p of patterns) {
      const match = trimmed.match(p.regex);
      if (match) {
        // Extra validation for all-caps: skip if it looks like a regular sentence
        if (p.type === 'allcaps') {
          const wordCount = trimmed.split(/\s+/).length;
          if (wordCount > 15) continue;
          // Single all-caps word must be at least 5 chars (avoids matching "THE", "AND" etc.)
          if (wordCount === 1 && trimmed.length < 5) continue;
          if (trimmed.endsWith('.') && wordCount > 8) continue;
        }
        // Extra validation for numbered: the title part should start with uppercase
        if (p.type === 'numbered') {
          if (!match[2] || match[2].trim().length < 2) continue;
        }
        // Extra validation for roman numerals: must be a valid Roman numeral
        if (p.type === 'roman') {
          if (!isValidRoman(match[1])) continue;
        }
        return { line: trimmed, isHeader: true, type: p.type, match, idx };
      }
    }
    return { line: trimmed, isHeader: false, idx };
  });

  // Check if we found a reasonable number of headers
  const headers = lineClassifications.filter(l => l.isHeader);
  if (headers.length === 0) {
    // No headers detected — split by double-newline paragraphs instead
    return splitByParagraphs(normalized);
  }

  // For all-caps-only detection: require at least 2 all-caps headers to avoid false positives
  const nonAllcapsHeaders = headers.filter(h => h.type !== 'allcaps');
  const onlyAllcaps = nonAllcapsHeaders.length === 0;
  if (onlyAllcaps && headers.length < 2) {
    return splitByParagraphs(normalized);
  }

  // Second pass: build sections from classified lines
  const sections = [];
  let currentSection = null;

  for (const cl of lineClassifications) {
    if (cl.isHeader) {
      if (currentSection) {
        currentSection.content = currentSection.content.trim();
        sections.push(currentSection);
      }
      const parsed = parseHeaderInfo(cl);
      currentSection = { number: parsed.number, title: parsed.title, content: '' };
    } else {
      if (cl.line === '' && currentSection) {
        currentSection.content += '\n';
      } else if (cl.line) {
        if (currentSection) {
          currentSection.content += (currentSection.content.endsWith('\n') || !currentSection.content ? '' : '\n') + cl.line;
        } else {
          // Content before any header — Preamble
          currentSection = { number: '0', title: 'Preamble', content: cl.line };
        }
      }
    }
  }
  if (currentSection) {
    currentSection.content = currentSection.content.trim();
    sections.push(currentSection);
  }

  // Renumber sections sequentially if numbers are missing
  let autoNum = 0;
  for (const s of sections) {
    if (!s.number || s.number === '0') {
      autoNum++;
      s.number = String(autoNum);
    } else {
      autoNum++;
    }
  }

  return sections.length > 0 ? sections : [{ number: '1', title: 'Main Content', content: text }];
}

// Fallback: split plain text into sections by paragraph breaks when no headers are detected
function splitByParagraphs(text) {
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length <= 1) {
    return [{ number: '1', title: 'Main Content', content: text.trim() }];
  }
  // Try to use the first line of each paragraph as a title if it's short enough
  return paragraphs.map((para, i) => {
    const lines = para.split('\n');
    const firstLine = lines[0].trim();
    // If first line is short and looks like a title, use it
    if (firstLine.length < 100 && lines.length > 1) {
      return { number: String(i + 1), title: firstLine, content: lines.slice(1).join('\n').trim() };
    }
    return { number: String(i + 1), title: `Section ${i + 1}`, content: para };
  });
}

function parseHeaderInfo(classification) {
  const { type, match, line } = classification;
  switch (type) {
    case 'article': {
      const num = match[2];
      const title = match[3]?.trim() || `Article ${num}`;
      return { number: `Art. ${num}`, title };
    }
    case 'section': {
      return { number: match[2], title: match[3]?.trim() || `Section ${match[2]}` };
    }
    case 'exhibit': {
      return { number: `${match[1]} ${match[2]}`, title: match[3]?.trim() || `${match[1]} ${match[2]}` };
    }
    case 'numbered': {
      return { number: match[1], title: match[2]?.trim() || '' };
    }
    case 'lettered': {
      return { number: `(${match[1]})`, title: match[2]?.trim() || '' };
    }
    case 'roman': {
      return { number: match[1], title: match[2]?.trim() || '' };
    }
    case 'allcaps': {
      return { number: '', title: toTitleCase(match[1].trim()) };
    }
    case 'keyword': {
      return { number: '', title: toTitleCase(match[1].trim()) };
    }
    default:
      return { number: '', title: line };
  }
}

function parseNumberFromTitle(rawTitle) {
  // Try to extract structured number/title from heading text

  // EXHIBIT B-1, STATEMENT OF WORK / EXHIBIT A / SCHEDULE 1 / APPENDIX B-2
  const exhibitMatch = rawTitle.match(/^(EXHIBIT|SCHEDULE|APPENDIX|ANNEX|ATTACHMENT)\s+([A-Z0-9][-A-Z0-9]*)\s*[,.\s]*[-–—:]?\s*(.*)$/i);
  if (exhibitMatch) {
    const label = exhibitMatch[1].toUpperCase();
    const id = exhibitMatch[2].toUpperCase();
    const rest = exhibitMatch[3]?.trim();
    return { number: `${label} ${id}`, title: rest || `${label} ${id}` };
  }

  // ARTICLE I / ARTICLE 1
  const articleMatch = rawTitle.match(/^(?:ARTICLE|Article)\s+([IVXLCDM]+|\d+)\.?\s*[-–—:]?\s*(.*)$/);
  if (articleMatch) return { number: `Art. ${articleMatch[1]}`, title: articleMatch[2].trim() || rawTitle };

  // SECTION 1.1 / Section 3
  const sectionMatch = rawTitle.match(/^(?:SECTION|Section)\s+(\d+(?:\.\d+)*)\.?\s*[-–—:]?\s*(.*)$/);
  if (sectionMatch) return { number: sectionMatch[1], title: sectionMatch[2].trim() || rawTitle };

  // Plain number: "1." or "1.2" at start
  const numMatch = rawTitle.match(/^(\d+(?:\.\d+)*)\.?\s*[-–—:]?\s*(.+)$/);
  if (numMatch) return { number: numMatch[1], title: numMatch[2].trim() };

  // No number detected — use title as-is
  return { number: '', title: rawTitle };
}

function isValidRoman(str) {
  return /^(M{0,4})(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/.test(str) && str.length > 0;
}

function toTitleCase(str) {
  return str.toLowerCase().replace(/(?:^|\s|[-/])\S/g, c => c.toUpperCase());
}

// Re-parse a single DOCX contract using the full-text extractor
async function reparseContract(contractId) {
  const db = getDb();
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contractId);
  if (!contract || !contract.file_path || contract.file_type !== 'docx') {
    return { success: false, reason: 'Not a DOCX contract' };
  }

  const fullPath = path.join(__dirname, '..', 'uploads', contract.file_path);
  if (!fs.existsSync(fullPath)) {
    return { success: false, reason: 'File not found: ' + fullPath };
  }

  let htmlContent;
  try {
    const mammoth = require('mammoth');
    const htmlResult = await mammoth.convertToHtml({ path: fullPath });
    htmlContent = htmlResult.value;
  } catch (err) {
    console.error('[Reparse] mammoth failed for contract', contractId, err.message);
    return { success: false, reason: 'HTML extraction failed' };
  }

  if (!htmlContent) {
    return { success: false, reason: 'mammoth returned empty HTML' };
  }

  const sections = [{ number: '1', title: 'Full Contract', content: htmlContent }];

  // Replace sections in the database
  db.prepare('DELETE FROM contract_sections WHERE contract_id = ?').run(contractId);
  const insertSection = db.prepare(`
    INSERT INTO contract_sections (contract_id, section_number, title, content, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < sections.length; i++) {
    insertSection.run(contractId, sections[i].number || String(i + 1), sections[i].title || '', sections[i].content, i);
  }

  db.prepare('UPDATE contracts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(contractId);

  return { success: true, sectionCount: sections.length };
}

// Re-parse ALL DOCX contracts in the database
async function reparseAllDocxContracts() {
  const db = getDb();
  const contracts = db.prepare("SELECT id, title FROM contracts WHERE file_type = 'docx'").all();
  if (contracts.length === 0) {
    console.log('[Reparse] No DOCX contracts to re-parse.');
    return;
  }

  console.log(`[Reparse] Re-parsing ${contracts.length} DOCX contract(s) with latest parser...`);
  for (const c of contracts) {
    const result = await reparseContract(c.id);
    if (result.success) {
      console.log(`[Reparse]   Contract #${c.id} "${c.title}": ${result.sectionCount} sections`);
    } else {
      console.log(`[Reparse]   Contract #${c.id} "${c.title}": SKIPPED (${result.reason})`);
    }
  }
  console.log('[Reparse] Done.');
}

// API endpoint: POST /api/contracts/:id/reparse
router.post('/:id/reparse', authenticate, requireRole('admin', 'editor'), async (req, res) => {
  try {
    const result = await reparseContract(req.params.id);
    if (result.success) {
      logAction(req.user.id, 'reparse_contract', 'contract', Number(req.params.id));
      res.json({ message: `Re-parsed successfully: ${result.sectionCount} sections`, sectionCount: result.sectionCount });
    } else {
      res.status(400).json({ error: result.reason });
    }
  } catch (err) {
    console.error('Reparse error:', err);
    res.status(500).json({ error: 'Failed to re-parse: ' + err.message });
  }
});

// API endpoint: GET /api/contracts/:id/diagnostics — view parse debug log
router.get('/:id/diagnostics', authenticate, (req, res) => {
  try {
    const debugPath = path.join(__dirname, '..', '..', 'data', 'debug_docx_parse.log');
    const sectionsPath = path.join(__dirname, '..', '..', 'data', 'debug_parsed_sections.json');
    const log = fs.existsSync(debugPath) ? fs.readFileSync(debugPath, 'utf-8') : '(no debug log yet)';
    let sections = [];
    try { sections = JSON.parse(fs.readFileSync(sectionsPath, 'utf-8')); } catch (e) { /* ignore */ }
    res.json({ log, sections });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.reparseAllDocxContracts = reparseAllDocxContracts;
