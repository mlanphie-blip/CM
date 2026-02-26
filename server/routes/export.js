const express = require('express');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../database');
const { authenticate } = require('../middleware/auth');
const { logAction } = require('../services/audit');

const router = express.Router();

// Generate redline document (showing tracked changes)
router.get('/redline/:contractId', authenticate, (req, res) => {
  const db = getDb();
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.contractId);
  if (!contract) return res.status(404).json({ error: 'Contract not found' });

  const sections = db.prepare(
    'SELECT * FROM contract_sections WHERE contract_id = ? ORDER BY sort_order'
  ).all(req.params.contractId);

  const approvedProposals = db.prepare(`
    SELECT p.*, cs.section_number FROM proposals p
    LEFT JOIN contract_sections cs ON p.section_id = cs.id
    WHERE p.contract_id = ? AND p.status = 'approved'
    ORDER BY p.updated_at ASC
  `).all(req.params.contractId);

  // Build redline HTML
  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Redline - ${escapeHtml(contract.title)}</title>
  <style>
    body { font-family: 'Times New Roman', serif; max-width: 800px; margin: 40px auto; line-height: 1.6; color: #333; }
    h1 { text-align: center; border-bottom: 2px solid #333; padding-bottom: 10px; }
    .section { margin: 20px 0; }
    .section-header { font-weight: bold; margin-bottom: 5px; }
    .deleted { color: red; text-decoration: line-through; background: #ffe0e0; }
    .added { color: green; background: #e0ffe0; }
    .amendment-note { color: #666; font-style: italic; font-size: 0.9em; margin: 5px 0; border-left: 3px solid #999; padding-left: 10px; }
    .change-log { margin-top: 40px; border-top: 2px solid #333; padding-top: 20px; }
    .change-log table { width: 100%; border-collapse: collapse; }
    .change-log th, .change-log td { border: 1px solid #ccc; padding: 8px; text-align: left; }
    .change-log th { background: #f5f5f5; }
  </style></head><body>`;

  html += `<h1>REDLINE VERSION<br/>${escapeHtml(contract.title)}</h1>`;
  html += `<p style="text-align:center;color:#666;">Generated on ${new Date().toLocaleDateString()}</p>`;

  const Diff = require('diff');

  for (const section of sections) {
    html += `<div class="section">`;
    html += `<div class="section-header">${escapeHtml(section.section_number)}. ${escapeHtml(section.title || '')}</div>`;

    const sectionProposals = approvedProposals.filter(p => p.section_id === section.id);
    if (sectionProposals.length > 0) {
      for (const proposal of sectionProposals) {
        const diff = Diff.diffWords(proposal.original_text, proposal.proposed_text);
        html += `<p>`;
        for (const part of diff) {
          if (part.added) {
            html += `<span class="added">${escapeHtml(part.value)}</span>`;
          } else if (part.removed) {
            html += `<span class="deleted">${escapeHtml(part.value)}</span>`;
          } else {
            html += escapeHtml(part.value);
          }
        }
        html += `</p>`;
        html += `<div class="amendment-note">Amendment: ${escapeHtml(proposal.title)} — ${escapeHtml(proposal.rationale || '')}</div>`;
      }
    } else {
      html += `<p>${escapeHtml(section.content)}</p>`;
    }
    html += `</div>`;
  }

  // Change log
  html += `<div class="change-log"><h2>Amendment Log</h2><table>`;
  html += `<tr><th>#</th><th>Section</th><th>Description</th><th>Status</th><th>Date</th></tr>`;
  for (let i = 0; i < approvedProposals.length; i++) {
    const p = approvedProposals[i];
    html += `<tr><td>${i + 1}</td><td>${escapeHtml(p.section_number || 'N/A')}</td><td>${escapeHtml(p.title)}</td><td>Approved</td><td>${p.updated_at}</td></tr>`;
  }
  html += `</table></div></body></html>`;

  logAction(req.user.id, 'export_redline', 'contract', Number(req.params.contractId));

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename="redline-${contract.title.replace(/[^a-zA-Z0-9]/g, '_')}.html"`);
  res.send(html);
});

// Generate clean version (changes incorporated)
router.get('/clean/:contractId', authenticate, (req, res) => {
  const db = getDb();
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.contractId);
  if (!contract) return res.status(404).json({ error: 'Contract not found' });

  const sections = db.prepare(
    'SELECT * FROM contract_sections WHERE contract_id = ? ORDER BY sort_order'
  ).all(req.params.contractId);

  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(contract.title)}</title>
  <style>
    body { font-family: 'Times New Roman', serif; max-width: 800px; margin: 40px auto; line-height: 1.6; color: #333; }
    h1 { text-align: center; border-bottom: 2px solid #333; padding-bottom: 10px; }
    .section { margin: 20px 0; }
    .section-header { font-weight: bold; margin-bottom: 5px; }
  </style></head><body>`;

  html += `<h1>${escapeHtml(contract.title)}</h1>`;
  html += `<p style="text-align:center;color:#666;">Clean version — ${new Date().toLocaleDateString()}</p>`;

  for (const section of sections) {
    html += `<div class="section">`;
    html += `<div class="section-header">${escapeHtml(section.section_number)}. ${escapeHtml(section.title || '')}</div>`;
    html += `<p>${escapeHtml(section.content)}</p>`;
    html += `</div>`;
  }

  html += `</body></html>`;

  logAction(req.user.id, 'export_clean', 'contract', Number(req.params.contractId));

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename="clean-${contract.title.replace(/[^a-zA-Z0-9]/g, '_')}.html"`);
  res.send(html);
});

// Generate DOCX export
router.get('/docx/:contractId', authenticate, async (req, res) => {
  try {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');
    const db = getDb();
    const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.contractId);
    if (!contract) return res.status(404).json({ error: 'Contract not found' });

    const sections = db.prepare(
      'SELECT * FROM contract_sections WHERE contract_id = ? ORDER BY sort_order'
    ).all(req.params.contractId);

    const isRedline = req.query.type === 'redline';
    const children = [];

    children.push(new Paragraph({
      children: [new TextRun({ text: contract.title, bold: true, size: 32 })],
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER
    }));

    children.push(new Paragraph({
      children: [new TextRun({ text: `${isRedline ? 'Redline' : 'Clean'} version — ${new Date().toLocaleDateString()}`, italics: true, color: '666666', size: 20 })],
      alignment: AlignmentType.CENTER
    }));

    children.push(new Paragraph({ children: [] }));

    if (isRedline) {
      const Diff = require('diff');
      const approvedProposals = db.prepare(`
        SELECT p.*, cs.section_number FROM proposals p
        LEFT JOIN contract_sections cs ON p.section_id = cs.id
        WHERE p.contract_id = ? AND p.status = 'approved'
      `).all(req.params.contractId);

      for (const section of sections) {
        children.push(new Paragraph({
          children: [new TextRun({ text: `${section.section_number}. ${section.title || ''}`, bold: true, size: 24 })],
          heading: HeadingLevel.HEADING_2
        }));

        const sectionProposals = approvedProposals.filter(p => p.section_id === section.id);
        if (sectionProposals.length > 0) {
          for (const proposal of sectionProposals) {
            const diff = Diff.diffWords(proposal.original_text, proposal.proposed_text);
            const runs = diff.map(part => {
              if (part.added) return new TextRun({ text: part.value, color: '008000', bold: true });
              if (part.removed) return new TextRun({ text: part.value, color: 'FF0000', strike: true });
              return new TextRun({ text: part.value });
            });
            children.push(new Paragraph({ children: runs }));
          }
        } else {
          children.push(new Paragraph({ children: [new TextRun({ text: section.content })] }));
        }
      }
    } else {
      for (const section of sections) {
        children.push(new Paragraph({
          children: [new TextRun({ text: `${section.section_number}. ${section.title || ''}`, bold: true, size: 24 })],
          heading: HeadingLevel.HEADING_2
        }));
        children.push(new Paragraph({ children: [new TextRun({ text: section.content })] }));
      }
    }

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);

    logAction(req.user.id, 'export_docx', 'contract', Number(req.params.contractId), { type: isRedline ? 'redline' : 'clean' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${isRedline ? 'redline' : 'clean'}-${contract.title.replace(/[^a-zA-Z0-9]/g, '_')}.docx"`);
    res.send(buffer);
  } catch (err) {
    console.error('DOCX export error:', err);
    res.status(500).json({ error: 'Failed to generate DOCX' });
  }
});

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = router;
