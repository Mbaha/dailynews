#!/usr/bin/env node
/**
 * Backfill TOC items for issues that already have page text in the DB.
 * Uses the same LLM extraction logic as ingest.mjs — Anthropic primary, Ollama fallback.
 *
 * Usage:
 *   export $(grep -v '^#' .env.local | xargs)
 *   node scripts/backfill-toc.mjs              # process issues with no TOC items
 *   node scripts/backfill-toc.mjs --force      # re-extract all issues (clears existing TOC data)
 *
 * Environment:
 *   CONCURRENCY=16   max simultaneous LLM calls per issue (default: 16)
 */

import pg from 'pg';

const { Client } = pg;
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/dikgang';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const TOC_MODEL = process.env.OLLAMA_TOC_MODEL || process.env.OLLAMA_CHAT_MODEL || 'gemma4:latest';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_TOC_MODEL = process.env.ANTHROPIC_TOC_MODEL || 'claude-haiku-4-5';
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 5);
const FORCE = process.argv.includes('--force');

class Semaphore {
  constructor(max) { this._max = max; this._count = 0; this._queue = []; }
  acquire() {
    if (this._count < this._max) { this._count++; return Promise.resolve(); }
    return new Promise((r) => this._queue.push(r));
  }
  release() {
    const next = this._queue.shift();
    if (next) next();
    else this._count--;
  }
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const query = FORCE
    ? 'SELECT id, file_name, issue_date::text FROM issues ORDER BY issue_date DESC NULLS LAST'
    : `SELECT i.id, i.file_name, i.issue_date::text
       FROM issues i
       WHERE NOT EXISTS (SELECT 1 FROM toc_items t WHERE t.issue_id = i.id)
       ORDER BY i.issue_date DESC NULLS LAST`;

  const issues = (await client.query(query)).rows;
  console.log(`[backfill-toc] ${issues.length} issues to process${FORCE ? ' (--force)' : ''} · concurrency=${CONCURRENCY}`);

  if (issues.length === 0) {
    console.log('Nothing to do.');
    await client.end();
    return;
  }

  if (FORCE && issues.length > 0) {
    const ids = issues.map((r) => r.id);
    await client.query('DELETE FROM toc_items WHERE issue_id = ANY($1::bigint[])', [ids]);
    console.log('[backfill-toc] Cleared existing TOC items for target issues');
  }

  const startMs = Date.now();
  let totalNews = 0, totalClassified = 0, failed = 0;

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const n = i + 1;
    try {
      const { news, classified } = await processIssue(client, issue);
      totalNews += news;
      totalClassified += classified;

      const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
      const eta = n < issues.length
        ? `ETA ${Math.round(((Date.now() - startMs) / n) * (issues.length - n) / 1000)}s`
        : 'done';
      console.log(`[${n}/${issues.length}] ${issue.file_name} — ${news} news, ${classified} classified · ${elapsed}s elapsed · ${eta}`);
    } catch (err) {
      failed++;
      console.error(`[${n}/${issues.length}] FAILED ${issue.file_name}: ${err.message}`);
    }
  }

  await client.end();
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`\n[backfill-toc] Done in ${elapsed}s — ${totalNews} news, ${totalClassified} classifieds, ${failed} failed`);
}

async function processIssue(client, issue) {
  const pages = (await client.query(
    'SELECT page_number, text FROM pages WHERE issue_id = $1 ORDER BY page_number',
    [issue.id]
  )).rows;

  if (pages.length === 0) return { news: 0, classified: 0 };

  const sem = new Semaphore(CONCURRENCY);
  const pageResults = await Promise.all(
    pages.map(async (page) => {
      await sem.acquire();
      try {
        return { pageNumber: page.page_number, items: await extractPageHeadlines(page.text, page.page_number) };
      } finally {
        sem.release();
      }
    })
  );

  const issueIds = [], pageNums = [], titles = [], orders = [], categories = [];
  for (const { pageNumber, items } of pageResults) {
    for (let j = 0; j < items.length; j++) {
      issueIds.push(issue.id);
      pageNums.push(pageNumber);
      titles.push(items[j].title);
      orders.push(j);
      categories.push(items[j].category);
    }
  }

  if (issueIds.length > 0) {
    await client.query(
      `INSERT INTO toc_items(issue_id, page_number, title, sort_order, category)
       SELECT * FROM unnest($1::bigint[], $2::int[], $3::text[], $4::int[], $5::text[])`,
      [issueIds, pageNums, titles, orders, categories]
    );
  }

  return {
    news: categories.filter((c) => c === 'news').length,
    classified: categories.filter((c) => c === 'classified').length,
  };
}

async function extractPageHeadlines(text, pageNumber) {
  if (!text || text.trim().length < 80) return [];

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
  if (ANTHROPIC_API_KEY) raw = await callAnthropicToc(prompt);
  if (!raw) raw = await callOllamaToc(prompt);
  return parseTocItems(raw);
}

async function callAnthropicToc(prompt, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
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
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429) {
        // Respect Retry-After if present, otherwise exponential backoff
        const retryAfter = Number(res.headers.get('retry-after') ?? 0);
        const wait = retryAfter > 0 ? retryAfter * 1000 : (2 ** attempt) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.content?.[0]?.text ?? '';
    } catch (err) {
      if (attempt === retries) {
        console.warn(`    [TOC] Anthropic unavailable (${err.message}), falling back to Ollama`);
        return '';
      }
      await new Promise((r) => setTimeout(r, (2 ** attempt) * 500));
    }
  }
  return '';
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
