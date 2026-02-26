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

    // Parse and insert sections — prefer HTML-based parsing for DOCX, fall back to text
    let sections;
    try {
      if (manualSections.length > 0) {
        sections = manualSections;
      } else if (extractedText.html) {
        sections = parseSectionsFromHtml(extractedText.html) || parseTextIntoSections(extractedText.text);
      } else {
        sections = parseTextIntoSections(extractedText.text || (typeof extractedText === 'string' ? extractedText : ''));
      }
    } catch (parseErr) {
      console.error('Section parsing error:', parseErr.message, parseErr.stack);
      const fallbackText = extractedText.text || (typeof extractedText === 'string' ? extractedText : '');
      sections = [{ number: '1', title: 'Main Content', content: fallbackText }];
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

// ---- Section Parsing Engine ----

// For DOCX: parse the HTML output from mammoth to detect section boundaries.
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
    // "EXHIBIT A" / "SCHEDULE 1" / "APPENDIX B" / "ANNEX 1"
    { regex: /^(EXHIBIT|SCHEDULE|APPENDIX|ANNEX|ATTACHMENT)\s+([A-Z0-9]+)\.?\s*[-–—:]?\s*(.*)$/i, type: 'exhibit' },
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
  // Try to extract "ARTICLE I - Title" or "Section 1.2 - Title" or "1. Title" from heading text
  // Check for explicit keywords first
  const articleMatch = rawTitle.match(/^(?:ARTICLE|Article)\s+([IVXLCDM]+|\d+)\.?\s*[-–—:]?\s*(.*)$/);
  if (articleMatch) return { number: `Art. ${articleMatch[1]}`, title: articleMatch[2].trim() || rawTitle };

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

module.exports = router;
