#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

const execFileAsync = promisify(execFile);
const { Client } = pg;
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const PAPERS_DIR = process.env.PAPERS_DIR || path.join(ROOT, 'news-papers');
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/dikgang';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || 'gemma4:latest';
const TOC_MODEL = process.env.OLLAMA_TOC_MODEL || CHAT_MODEL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_TOC_MODEL = process.env.ANTHROPIC_TOC_MODEL || 'claude-haiku-4-5';

const MONTHS = new Map(Object.entries({
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, nova: 11,
  november: 11, dec: 12, december: 12
}));
const WEEKDAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const MONTH_RE = [...MONTHS.keys()].sort((a, b) => b.length - a.length).join('|');
const MASTHEAD_RE = new RegExp(`\\b(?<weekday>${WEEKDAYS})\\s+(?<month>${MONTH_RE})\\s+(?<day>\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s+(?<year>20\\d{2})\\b`, 'i');
const ISSUE_NO_RE = /\bNo\.\s*([0-9]+)/i;

async function extractPageHeadlines(text, pageNumber) {
  if (!text || text.trim().length < 80) return [];

  // Collapse column-layout whitespace so the char budget covers real content.
  const condensed = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

  const prompt = `You are extracting content from a Botswana Daily News newspaper page.

The text was extracted with pdftotext from page ${pageNumber}. Multi-column layout may have garbled the order.

Return ONLY a valid JSON object with two arrays:
- "news": article headlines — up to 15 words, Title Case or ALL CAPS. Exclude bylines ("By Name"), captions, dates, page numbers, and body text.
- "classifieds": job ads, vacancy notices, tenders, legal notices, public notices, government notices, property ads, and farm/agricultural ads.

Example: {"news": ["Cabinet approves budget", "FLOODS HIT NORTH"], "classifieds": ["FARM WORKER NEEDED", "TENDER: Road upgrade"]}

Return {"news": [], "classifieds": []} if nothing is found. Output no other text.

Page text:
${condensed.slice(0, 6000)}`;

  let raw = '';
  if (ANTHROPIC_API_KEY) {
    raw = await callAnthropicToc(prompt);
  }
  if (!raw) {
    raw = await callOllamaToc(prompt);
  }
  return parseTocItems(raw);
}

async function callAnthropicToc(prompt) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_TOC_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.content?.[0]?.text ?? '';
  } catch (err) {
    console.warn(`[TOC] Anthropic unavailable (${err.message}), falling back to Ollama`);
    return '';
  }
}

async function callOllamaToc(prompt) {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TOC_MODEL, prompt, stream: false }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return data.response ?? '';
  } catch {
    return '';
  }
}

function parseTocItems(raw) {
  try {
    const cleaned = (raw ?? '').trim()
      .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    // Legacy format: plain array → treat all as news
    if (Array.isArray(parsed)) {
      return filterTitles(parsed, 8).map((title) => ({ title, category: 'news' }));
    }
    const news = filterTitles(parsed.news ?? [], 15).map((title) => ({ title, category: 'news' }));
    const classifieds = filterTitles(parsed.classifieds ?? [], 15).map((title) => ({ title, category: 'classified' }));
    return [...news, ...classifieds];
  } catch {
    return [];
  }
}

function filterTitles(arr, limit) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((h) => typeof h === 'string' && h.trim().length >= 8 && h.trim().length <= 120)
    .map((h) => h.trim())
    .slice(0, limit);
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  const job = await client.query('INSERT INTO ingest_jobs(status, message) VALUES($1, $2) RETURNING id', ['running', 'Scanning PDFs']);
  const jobId = job.rows[0].id;
  try {
    const pdfs = await findPdfs(PAPERS_DIR);
    let inserted = 0, updated = 0, skipped = 0, errored = 0;
    for (const pdf of pdfs) {
      try {
        const result = await ingestPdf(client, pdf);
        if (result === 'inserted') inserted++;
        else if (result === 'updated') updated++;
        else skipped++;
      } catch (err) {
        errored++;
        console.warn(`[ingest] Skipping ${path.basename(pdf)}: ${err.message}`);
      }
    }
    const message = `Ingest complete. PDFs=${pdfs.length}, inserted=${inserted}, updated=${updated}, skipped=${skipped}, errored=${errored}`;
    await client.query('UPDATE ingest_jobs SET status=$1, message=$2, finished_at=now() WHERE id=$3', ['complete', message, jobId]);
    console.log(message);
  } catch (err) {
    await client.query('UPDATE ingest_jobs SET status=$1, message=$2, finished_at=now() WHERE id=$3', ['failed', String(err.stack || err), jobId]);
    throw err;
  } finally {
    await client.end();
  }
}

async function findPdfs(dir) {
  const out = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) out.push(full);
    }
  }
  await walk(dir);
  return out.sort((a, b) => a.localeCompare(b));
}

async function ingestPdf(client, filePath) {
  const rel = path.relative(ROOT, filePath);
  const stat = await fs.stat(filePath);
  const hash = crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');

  const existing = await client.query('SELECT id, sha256 FROM issues WHERE file_path=$1', [rel]);
  if (existing.rowCount && existing.rows[0].sha256 === hash) return 'skipped';

  const pageCount = await getPageCount(filePath);
  const firstText = await getText(filePath, 1, 1);
  const detected = detectDate(firstText);
  const issueNumber = firstText.match(ISSUE_NO_RE)?.[1] || null;
  const allPageTexts = [];
  for (let page = 1; page <= pageCount; page++) {
    allPageTexts.push(await getText(filePath, page, page));
  }

  let issueId;
  await client.query('BEGIN');
  try {
    const params = [
      rel, path.basename(filePath), stat.size, stat.mtime, hash,
      detected.iso, detected.iso, detected.source, detected.confidence,
      !detected.iso || detected.confidence < 0.8,
      'Botswana Daily News', issueNumber, pageCount, preview(firstText)
    ];
    if (existing.rowCount) {
      issueId = existing.rows[0].id;
      await client.query(`
        UPDATE issues SET file_name=$2, file_size=$3, file_mtime=$4, sha256=$5,
          issue_date=COALESCE(corrected_date, $6), detected_date=$7, date_source=$8,
          date_confidence=$9, needs_date_review=$10, title=$11, issue_number=$12,
          page_count=$13, first_page_preview=$14, updated_at=now()
        WHERE file_path=$1
      `, params);
      await client.query('DELETE FROM pages WHERE issue_id=$1', [issueId]);
      await client.query('DELETE FROM toc_items WHERE issue_id=$1', [issueId]);
    } else {
      const inserted = await client.query(`
        INSERT INTO issues(file_path, file_name, file_size, file_mtime, sha256, issue_date,
          detected_date, date_source, date_confidence, needs_date_review, title, issue_number,
          page_count, first_page_preview)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING id
      `, params);
      issueId = inserted.rows[0].id;
    }

    for (let i = 0; i < allPageTexts.length; i++) {
      const pageNo = i + 1;
      const page = await client.query(
        'INSERT INTO pages(issue_id, page_number, text) VALUES($1,$2,$3) RETURNING id',
        [issueId, pageNo, allPageTexts[i]]
      );
      const chunks = chunkText(allPageTexts[i], 1200, 180);
      for (let c = 0; c < chunks.length; c++) {
        await client.query(
          'INSERT INTO chunks(issue_id, page_id, page_number, chunk_index, text, token_estimate) VALUES($1,$2,$3,$4,$5,$6)',
          [issueId, page.rows[0].id, pageNo, c, chunks[c], Math.ceil(chunks[c].length / 4)]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  // TOC extraction runs after the committed transaction — a failure here is non-fatal
  // and won't roll back the pages/chunks that were just saved.
  const tocIssueIds = [], tocPageNums = [], tocTitles = [], tocOrders = [], tocCategories = [];
  for (let i = 0; i < allPageTexts.length; i++) {
    const items = await extractPageHeadlines(allPageTexts[i], i + 1);
    for (let j = 0; j < items.length; j++) {
      tocIssueIds.push(issueId);
      tocPageNums.push(i + 1);
      tocTitles.push(items[j].title);
      tocOrders.push(j);
      tocCategories.push(items[j].category);
    }
  }
  if (tocIssueIds.length > 0) {
    await client.query(
      `INSERT INTO toc_items(issue_id, page_number, title, sort_order, category)
       SELECT * FROM unnest($1::bigint[], $2::int[], $3::text[], $4::int[], $5::text[])`,
      [tocIssueIds, tocPageNums, tocTitles, tocOrders, tocCategories]
    );
  }

  return existing.rowCount ? 'updated' : 'inserted';
}

async function getPageCount(filePath) {
  const { stdout } = await execFileAsync('pdfinfo', [filePath], { maxBuffer: 1024 * 1024 });
  const match = stdout.match(/^Pages:\s+(\d+)/m);
  if (!match) throw new Error(`Could not read page count for ${filePath}`);
  return Number(match[1]);
}

async function getText(filePath, first, last) {
  const { stdout } = await execFileAsync('pdftotext', ['-f', String(first), '-l', String(last), '-layout', filePath, '-'], { maxBuffer: 50 * 1024 * 1024 });
  return stdout.replace(/\u0000/g, '').trim();
}

function detectDate(text) {
  const match = text.match(MASTHEAD_RE);
  if (!match?.groups) return { iso: null, source: null, confidence: 0 };
  const month = MONTHS.get(match.groups.month.toLowerCase());
  const iso = `${match.groups.year}-${String(month).padStart(2, '0')}-${String(Number(match.groups.day)).padStart(2, '0')}`;
  return { iso, source: 'first_page_masthead', confidence: 0.98 };
}

function preview(text) {
  return text.split(/\n+/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 10).join('\n').slice(0, 1200);
}

function chunkText(text, targetChars, overlapChars) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const chunks = [];
  let start = 0;
  while (start < cleaned.length) {
    let end = Math.min(cleaned.length, start + targetChars);
    const boundary = cleaned.lastIndexOf('.', end);
    if (boundary > start + targetChars * 0.55) end = boundary + 1;
    chunks.push(cleaned.slice(start, end).trim());
    if (end >= cleaned.length) break;
    start = Math.max(0, end - overlapChars);
  }
  return chunks;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
