#!/usr/bin/env node
/**
 * Run this against your DOCX file to diagnose parsing issues:
 *   node diagnose.js path/to/your/contract.docx
 *
 * It prints EXACTLY what the parser sees and produces, so we can
 * identify where the numbering goes wrong.
 */
const fs = require('fs');
const path = require('path');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node diagnose.js <path-to-docx>');
  process.exit(1);
}
if (!fs.existsSync(filePath)) {
  console.error('File not found:', filePath);
  process.exit(1);
}

async function main() {
  const JSZip = require('jszip');
  const { DOMParser } = require('@xmldom/xmldom');
  const mammoth = require('mammoth');

  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);
  const parser = new DOMParser();

  console.log('='.repeat(80));
  console.log('DOCX DIAGNOSTIC REPORT');
  console.log('File:', filePath, '(' + data.length + ' bytes)');
  console.log('='.repeat(80));

  // ---- 1. Check what's inside the DOCX ZIP ----
  const zipFiles = Object.keys(zip.files);
  console.log('\n--- ZIP Contents ---');
  console.log('Has numbering.xml:', zipFiles.includes('word/numbering.xml'));
  console.log('Has styles.xml:', zipFiles.includes('word/styles.xml'));
  console.log('Has document.xml:', zipFiles.includes('word/document.xml'));

  // ---- 2. Parse numbering.xml ----
  const numXmlStr = await zip.file('word/numbering.xml')?.async('string');
  if (!numXmlStr) {
    console.log('\n*** NO numbering.xml — Word auto-numbering is NOT used in this document');
    console.log('*** Numbers may be embedded in the text content instead');
  } else {
    const numDoc = parser.parseFromString(numXmlStr, 'text/xml');

    console.log('\n--- Abstract Numbering Definitions ---');
    const abstractNums = numDoc.getElementsByTagName('w:abstractNum');
    const abstractDefs = {};
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
        console.log(`  abstractNum ${id}, level ${ilvl}: start=${levels[ilvl].start} fmt=${levels[ilvl].numFmt} text="${levels[ilvl].lvlText}"`);
      }
      abstractDefs[id] = { levels };
    }

    console.log('\n--- Num Definitions (numId → abstractNumId) ---');
    const numDefs = {};
    const nums = numDoc.getElementsByTagName('w:num');
    for (let i = 0; i < nums.length; i++) {
      const num = nums[i];
      const numId = num.getAttribute('w:numId');
      const abstractRefEl = getDirectChild(num, 'w:abstractNumId');
      const abstractRef = abstractRefEl?.getAttribute('w:val');

      let overrideInfo = [];
      for (let c = num.firstChild; c; c = c.nextSibling) {
        if (c.nodeName === 'w:lvlOverride') {
          const ilvl = c.getAttribute('w:ilvl');
          const startOvr = getDirectChild(c, 'w:startOverride');
          const lvlDef = getDirectChild(c, 'w:lvl');
          let info = `ilvl=${ilvl}`;
          if (startOvr) info += ` startOverride=${startOvr.getAttribute('w:val')}`;
          if (lvlDef) info += ' [has embedded lvl definition]';
          overrideInfo.push(info);
        }
      }

      const levels = {};
      if (abstractRef && abstractDefs[abstractRef]) {
        for (const [lvl, def] of Object.entries(abstractDefs[abstractRef].levels)) {
          levels[lvl] = { ...def };
        }
      }
      numDefs[numId] = { levels, abstractRef };

      console.log(`  num ${numId} → abstractNum ${abstractRef}${overrideInfo.length ? ' overrides: ' + overrideInfo.join(', ') : ''}`);
    }

    // ---- 3. Parse document.xml ----
    const docXmlStr = await zip.file('word/document.xml').async('string');
    const docDoc = parser.parseFromString(docXmlStr, 'text/xml');
    const pElements = docDoc.getElementsByTagName('w:p');

    console.log('\n--- All Paragraphs (with numbering) ---');
    console.log(`Total paragraphs: ${pElements.length}`);

    const counters = {};
    let paraNum = 0;

    for (let i = 0; i < pElements.length; i++) {
      const p = pElements[i];

      let text = '';
      const runs = p.getElementsByTagName('w:t');
      for (let j = 0; j < runs.length; j++) text += runs[j].textContent || '';
      text = text.trim();
      if (!text) continue;

      paraNum++;

      // Check for bold
      let isBold = false;
      const rElements = p.getElementsByTagName('w:r');
      if (rElements.length > 0) {
        let allBold = true;
        for (let j = 0; j < rElements.length; j++) {
          const rPr = getDirectChild(rElements[j], 'w:rPr');
          if (!rPr || !getDirectChild(rPr, 'w:b')) {
            let rt = '';
            const ts = rElements[j].getElementsByTagName('w:t');
            for (let k = 0; k < ts.length; k++) rt += ts[k].textContent || '';
            if (rt.trim()) { allBold = false; break; }
          }
        }
        isBold = allBold && rElements.length > 0;
      }

      // Get numbering
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
        // Check style-based numbering
        if (!numId) {
          const pStyleEl = getDirectChild(pPr, 'w:pStyle');
          if (pStyleEl) {
            const styleId = pStyleEl.getAttribute('w:val');
            // Note: we'd need styles.xml to resolve this fully
            console.log(`  P${paraNum}: [style=${styleId}] ${isBold ? '[BOLD] ' : ''}${text.substring(0, 70)}`);
            continue;
          }
        }
      }

      if (numId === '0') { numId = null; ilvl = null; }

      // Compute the actual number
      let computedNumber = '';
      if (numId && numDefs[numId]) {
        const def = numDefs[numId];
        const level = ilvl || 0;
        const isBullet = def.levels[level]?.numFmt === 'bullet';

        if (!isBullet) {
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

          const lvlDef = def.levels[level];
          if (lvlDef) {
            computedNumber = lvlDef.lvlText;
            for (let l = 0; l <= level; l++) {
              const val = ctr[l] || 0;
              const fmt = def.levels[l]?.numFmt || 'decimal';
              computedNumber = computedNumber.replace('%' + (l + 1), formatNum(val, fmt));
            }
            computedNumber = computedNumber.replace(/\.+$/, '');
          } else {
            computedNumber = '???(no lvl def for ' + level + ')';
          }
        } else {
          computedNumber = '(bullet)';
        }
      }

      const numInfo = numId ? `numId=${numId} ilvl=${ilvl}` : 'NO-NUM';
      console.log(`  P${paraNum}: [${numInfo}] → "${computedNumber}" ${isBold ? '[BOLD] ' : ''}${text.substring(0, 60)}`);
    }
  }

  // ---- 4. Mammoth HTML output ----
  console.log('\n--- Mammoth HTML Output (structure) ---');
  try {
    const htmlResult = await mammoth.convertToHtml({ path: filePath });
    const { parse } = require('node-html-parser');
    const root = parse(htmlResult.value);

    let itemCount = 0;
    function walkNode(node, depth) {
      const tag = (node.tagName || '').toLowerCase();
      if (tag === 'p') {
        itemCount++;
        const bold = node.querySelector('strong, b');
        const text = node.textContent.trim();
        if (text) console.log('  ' + '  '.repeat(depth) + '<p>' + (bold ? '[BOLD] ' : '') + text.substring(0, 60));
      } else if (tag === 'ol' || tag === 'ul') {
        console.log('  ' + '  '.repeat(depth) + '<' + tag + '>');
        for (const child of node.childNodes) walkNode(child, depth + 1);
        console.log('  ' + '  '.repeat(depth) + '</' + tag + '>');
      } else if (tag === 'li') {
        itemCount++;
        let text = '';
        let hasNestedList = false;
        for (const child of node.childNodes) {
          const ct = (child.tagName || '').toLowerCase();
          if (ct === 'ol' || ct === 'ul') hasNestedList = true;
          else text += child.textContent || '';
        }
        const bold = node.querySelector('strong, b');
        console.log('  ' + '  '.repeat(depth) + '<li>' + (bold ? '[BOLD] ' : '') + text.trim().substring(0, 60) + (hasNestedList ? ' [+children]' : ''));
        for (const child of node.childNodes) {
          const ct = (child.tagName || '').toLowerCase();
          if (ct === 'ol' || ct === 'ul') walkNode(child, depth + 1);
        }
      } else if (tag && /^h[1-6]$/.test(tag)) {
        itemCount++;
        console.log('  ' + '  '.repeat(depth) + '<' + tag + '>' + node.textContent.trim().substring(0, 60));
      } else if (node.childNodes) {
        for (const child of node.childNodes) walkNode(child, depth);
      }
    }
    walkNode(root, 0);
    console.log('  Total content items:', itemCount);
    console.log('  HTML length:', htmlResult.value.length, 'bytes');
  } catch (err) {
    console.log('  Mammoth error:', err.message);
  }

  // ---- 5. Raw text output ----
  console.log('\n--- Raw Text (first 30 lines) ---');
  try {
    const textResult = await mammoth.extractRawText({ path: filePath });
    const lines = textResult.value.split('\n').filter(l => l.trim());
    for (let i = 0; i < Math.min(30, lines.length); i++) {
      console.log(`  L${i + 1}: ${lines[i].substring(0, 80)}`);
    }
    console.log(`  ... total ${lines.length} non-empty lines`);
  } catch (err) {
    console.log('  Mammoth text error:', err.message);
  }

  console.log('\n' + '='.repeat(80));
  console.log('END OF DIAGNOSTIC REPORT');
  console.log('='.repeat(80));
}

function getDirectChild(parent, tagName) {
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (c.nodeName === tagName) return c;
  }
  return null;
}

function formatNum(val, fmt) {
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

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
