#!/usr/bin/env node
/**
 * One-off cleanup: finds all Daily News messages from op-pr-office@gov.bw
 * in the inbox (read or unread) and moves them to Deleted Items.
 *
 * Usage:
 *   node scripts/mail-cleanup.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import httpntlm from 'httpntlm';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_DIR = path.join(process.env.HOME, '.config', 'dikgang');
const SENDER = 'op-pr-office@gov.bw';

// Load ~/.config/dikgang/mail.env
try {
  const envFile = path.join(CONFIG_DIR, 'mail.env');
  for (const line of (await fs.readFile(envFile, 'utf8')).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
} catch { /* rely on env vars already set */ }

function requireEnv(name) {
  const val = process.env[name];
  if (!val) { console.error(`Missing: ${name}`); process.exit(1); }
  return val;
}

function parseCredentials() {
  const raw = requireEnv('MAIL_USER');
  const password = requireEnv('MAIL_PASSWORD');
  const bslash = raw.indexOf('\\');
  if (bslash !== -1) return { domain: raw.slice(0, bslash), username: raw.slice(bslash + 1), password };
  return { domain: process.env.MAIL_DOMAIN ?? '', username: raw, password };
}

function ntlmPost(options) {
  return new Promise((resolve, reject) => {
    httpntlm.post(options, (err, res) => err ? reject(err) : resolve(res));
  });
}

const _creds = parseCredentials();
const _ewsUrl = `https://${requireEnv('MAIL_HOST')}/EWS/Exchange.asmx`;

function ewsEnvelope(body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2010_SP2"/>
  </soap:Header>
  <soap:Body>${body}</soap:Body>
</soap:Envelope>`;
}

async function ewsCall(body) {
  const res = await ntlmPost({
    url: _ewsUrl,
    username: _creds.username,
    password: _creds.password,
    domain: _creds.domain,
    workstation: '',
    body: ewsEnvelope(body),
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
  if (res.statusCode !== 200) throw new Error(`EWS HTTP ${res.statusCode}: ${String(res.body).slice(0, 300)}`);
  return String(res.body);
}

function parseItemIds(xml) {
  const re = /<(?:\w+:)?ItemId\s+Id="([^"]+)"\s+ChangeKey="([^"]+)"/gi;
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push({ id: m[1], changeKey: m[2] });
  return results;
}

function xmlTexts(xml, localName) {
  const re = new RegExp(`<(?:\\w+:)?${localName}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${localName}>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
  return results;
}

function normSubject(s) {
  return [...s].map(ch => {
    const cp = ch.codePointAt(0);
    if (cp >= 0x1D400 && cp <= 0x1D419) return String.fromCharCode(cp - 0x1D400 + 65);
    if (cp >= 0x1D41A && cp <= 0x1D433) return String.fromCharCode(cp - 0x1D41A + 97);
    return ch;
  }).join('').toLowerCase().replace(/\s+/g, '');
}

function isDailyNews(subject) {
  return normSubject(subject).includes('dailynews');
}

// Fetch ALL messages from sender (read + unread), paginated
async function findAllFromSender() {
  const pageSize = 100;
  let offset = 0;
  const all = [];

  while (true) {
    const xml = await ewsCall(`
      <m:FindItem Traversal="Shallow">
        <m:ItemShape>
          <t:BaseShape>IdOnly</t:BaseShape>
          <t:AdditionalProperties>
            <t:FieldURI FieldURI="item:Subject"/>
          </t:AdditionalProperties>
        </m:ItemShape>
        <m:IndexedPageItemView MaxEntriesReturned="${pageSize}" Offset="${offset}" BasePoint="Beginning"/>
        <m:Restriction>
          <t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase">
            <t:FieldURI FieldURI="message:From"/>
            <t:Constant Value="${SENDER}"/>
          </t:Contains>
        </m:Restriction>
        <m:ParentFolderIds>
          <t:DistinguishedFolderId Id="inbox"/>
        </m:ParentFolderIds>
      </m:FindItem>`);

    const items = parseItemIds(xml);
    const subjects = xmlTexts(xml, 'Subject');
    const page = items.map((item, i) => ({ ...item, subject: subjects[i] ?? '(no subject)' }));
    all.push(...page);

    // Stop if we got fewer than a full page
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return all;
}

async function deleteItems(ids) {
  // EWS DeleteItem accepts up to 100 items per call
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));

  for (const chunk of chunks) {
    const itemIds = chunk.map(({ id, changeKey }) =>
      `<t:ItemId Id="${id}" ChangeKey="${changeKey}"/>`
    ).join('\n');
    await ewsCall(`
      <m:DeleteItem DeleteType="MoveToDeletedItems">
        <m:ItemIds>${itemIds}</m:ItemIds>
      </m:DeleteItem>`);
  }
}

// --- main ---
console.log(`[cleanup] Connecting as ${_creds.domain ? _creds.domain + '\\' : ''}${_creds.username}`);
console.log(`[cleanup] Scanning inbox for all messages from ${SENDER}…`);

const all = await findAllFromSender();
console.log(`[cleanup] Found ${all.length} message(s) from sender.`);

const toDelete = all.filter(m => isDailyNews(m.subject));
const skipped  = all.filter(m => !isDailyNews(m.subject));

console.log(`[cleanup] Daily News to delete: ${toDelete.length}`);
console.log(`[cleanup] Non-Daily-News (leaving in inbox): ${skipped.length}`);
if (skipped.length) skipped.forEach(m => console.log(`[cleanup]   Keeping: "${m.subject}"`));

if (toDelete.length === 0) {
  console.log('[cleanup] Nothing to delete — inbox already clean.');
  process.exit(0);
}

toDelete.forEach(m => console.log(`[cleanup]   Deleting: "${m.subject}"`));
await deleteItems(toDelete);
console.log(`[cleanup] Done — ${toDelete.length} message(s) moved to Deleted Items.`);
