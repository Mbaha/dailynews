#!/usr/bin/env node
/**
 * Polls mkambimba@gov.bw via Exchange Web Services (EWS) for unread emails
 * from op-pr-office@gov.bw, downloads PDF attachments to news-papers/, and
 * marks messages as read.
 *
 * Uses HTTPS (port 443) — works wherever your mail app works.
 * No extra packages needed.
 *
 * Credentials in ~/.config/dikgang/mail.env:
 *   MAIL_HOST=your.exchange.server
 *   MAIL_USER=mkambimba@gov.bw
 *   MAIL_PASSWORD=your_password
 *
 * Guards — exits immediately (no network call) when:
 *   - Today's newspaper already fetched
 *   - Weekend
 *   - Botswana public holiday
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Holidays from 'date-holidays';
import httpntlm from 'httpntlm';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAPERS_DIR = process.env.PAPERS_DIR || path.join(ROOT, 'news-papers');
const CONFIG_DIR = path.join(process.env.HOME, '.config', 'dikgang');
const STATE_FILE = path.join(CONFIG_DIR, 'mail-state.json');
const SENDER = 'op-pr-office@gov.bw';

// ---------------------------------------------------------------------------
// Load ~/.config/dikgang/mail.env when run via npm (not the launchd wrapper)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Day guard
// ---------------------------------------------------------------------------
const hd = new Holidays('BW');

function todayIso() { return new Date().toISOString().slice(0, 10); }

function shouldSkipToday() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) { console.log('[mail] Weekend — nothing to fetch.'); return true; }
  const holiday = hd.isHoliday(now);
  if (holiday) { console.log(`[mail] Public holiday (${holiday[0].name}) — nothing to fetch.`); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); }
  catch { return { processed: [], lastFetchDate: null }; }
}

async function saveState(state) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// EWS SOAP helpers
// ---------------------------------------------------------------------------
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

// Parses MAIL_USER into { domain, username }.
// Accepts "DOMAIN\user" or plain "user" (with MAIL_DOMAIN env var as fallback).
function parseCredentials() {
  const raw = requireEnv('MAIL_USER');
  const password = requireEnv('MAIL_PASSWORD');
  const bslash = raw.indexOf('\\');
  if (bslash !== -1) {
    return { domain: raw.slice(0, bslash), username: raw.slice(bslash + 1), password };
  }
  return { domain: process.env.MAIL_DOMAIN ?? '', username: raw, password };
}

function ntlmPost(options) {
  return new Promise((resolve, reject) => {
    httpntlm.post(options, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

let _creds;   // set once in entry point after env is loaded
let _ewsUrl;

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
  if (res.statusCode !== 200) {
    throw new Error(`EWS HTTP ${res.statusCode}: ${String(res.body).slice(0, 300)}`);
  }
  return String(res.body);
}

// ---------------------------------------------------------------------------
// XML extraction (targeted regex — EWS responses have predictable structure)
// ---------------------------------------------------------------------------

// Returns all values of `attr` on elements whose local name is `localName`.
function xmlAttrs(xml, localName, attr) {
  const re = new RegExp(`<(?:\\w+:)?${localName}\\b[^>]*\\b${attr}="([^"]*)"`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1]);
  return results;
}

// Returns all text content between <ns:Tag> and </ns:Tag>.
function xmlTexts(xml, localName) {
  const re = new RegExp(`<(?:\\w+:)?${localName}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${localName}>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
  return results;
}

// Parses paired Id + ChangeKey attributes from ItemId elements.
function parseItemIds(xml) {
  const re = /<(?:\w+:)?ItemId\s+Id="([^"]+)"\s+ChangeKey="([^"]+)"/gi;
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push({ id: m[1], changeKey: m[2] });
  return results;
}

// ---------------------------------------------------------------------------
// EWS operations
// ---------------------------------------------------------------------------

async function findUnreadFromSender() {
  const xml = await ewsCall(`
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="item:HasAttachments"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:Restriction>
        <t:And>
          <t:IsEqualTo>
            <t:FieldURI FieldURI="message:IsRead"/>
            <t:FieldURIOrConstant><t:Constant Value="false"/></t:FieldURIOrConstant>
          </t:IsEqualTo>
          <t:IsEqualTo>
            <t:FieldURI FieldURI="item:HasAttachments"/>
            <t:FieldURIOrConstant><t:Constant Value="true"/></t:FieldURIOrConstant>
          </t:IsEqualTo>
          <t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase">
            <t:FieldURI FieldURI="message:From"/>
            <t:Constant Value="${SENDER}"/>
          </t:Contains>
        </t:And>
      </m:Restriction>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="inbox"/>
      </m:ParentFolderIds>
    </m:FindItem>`);

  const items = parseItemIds(xml);
  const subjects = xmlTexts(xml, 'Subject');
  return items.map((item, i) => ({ ...item, subject: subjects[i] ?? '(no subject)' }));
}

async function getAttachmentIds(itemId, changeKey) {
  const xml = await ewsCall(`
    <m:GetItem>
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Attachments"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:ItemIds>
        <t:ItemId Id="${itemId}" ChangeKey="${changeKey}"/>
      </m:ItemIds>
    </m:GetItem>`);

  // Collect FileAttachment sections — each has an AttachmentId and a Name.
  const ids = xmlAttrs(xml, 'AttachmentId', 'Id');
  const names = xmlTexts(xml, 'Name');
  const contentTypes = xmlTexts(xml, 'ContentType');

  return ids.map((id, i) => ({
    attachmentId: id,
    name: names[i] ?? `attachment-${i}.pdf`,
    contentType: contentTypes[i] ?? '',
  })).filter(({ name, contentType }) =>
    name.toLowerCase().endsWith('.pdf') || contentType === 'application/pdf'
  );
}

async function downloadAttachment(attachmentId) {
  const xml = await ewsCall(`
    <m:GetAttachment>
      <m:AttachmentShape>
        <t:IncludeMimeContent>true</t:IncludeMimeContent>
      </m:AttachmentShape>
      <m:AttachmentIds>
        <t:AttachmentId Id="${attachmentId}"/>
      </m:AttachmentIds>
    </m:GetAttachment>`);

  const [content] = xmlTexts(xml, 'Content');
  if (!content) throw new Error('No content in attachment response');
  return Buffer.from(content.replace(/\s+/g, ''), 'base64');
}

async function markAsRead(itemId, changeKey) {
  await ewsCall(`
    <m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AlwaysOverwrite">
      <m:ItemChanges>
        <t:ItemChange>
          <t:ItemId Id="${itemId}" ChangeKey="${changeKey}"/>
          <t:Updates>
            <t:SetItemField>
              <t:FieldURI FieldURI="message:IsRead"/>
              <t:Message><t:IsRead>true</t:IsRead></t:Message>
            </t:SetItemField>
          </t:Updates>
        </t:ItemChange>
      </m:ItemChanges>
    </m:UpdateItem>`);
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------
function sanitiseName(name) {
  return name.replace(/[^\w.\- ]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function resolveTargetPath(name) {
  const safe = sanitiseName(name);
  const target = path.join(PAPERS_DIR, safe);
  try {
    await fs.access(target);
    const ext = path.extname(safe);
    return path.join(PAPERS_DIR, `${path.basename(safe, ext)}-${Date.now()}${ext}`);
  } catch { return target; }
}

// ---------------------------------------------------------------------------
// Require env var
// ---------------------------------------------------------------------------
function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`[mail] Missing required environment variable: ${name}`);
    console.error(`[mail] Set it in ~/.config/dikgang/mail.env`);
    process.exit(1);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
if (shouldSkipToday()) process.exit(0);

const state = await loadState();
if (state.lastFetchDate === todayIso()) {
  console.log(`[mail] Today's newspaper already fetched (${state.lastFetchDate}) — done.`);
  process.exit(0);
}

_ewsUrl = `https://${requireEnv('MAIL_HOST')}/EWS/Exchange.asmx`;
_creds = parseCredentials();
console.log(`[mail] Connecting as ${_creds.domain ? _creds.domain + '\\' : ''}${_creds.username}`);

let downloaded = 0;
try {
  const messages = await findUnreadFromSender();

  if (messages.length === 0) {
    console.log('[mail] No new messages from sender.');
  } else {
    console.log(`[mail] Found ${messages.length} unread message(s) from ${SENDER}.`);
    for (const { id, changeKey, subject } of messages) {
      if (state.processed.includes(id)) continue;
      console.log(`[mail] Message: "${subject}"`);

      const attachments = await getAttachmentIds(id, changeKey);
      if (attachments.length === 0) {
        console.log('[mail]   No PDF attachments — skipping.');
        state.processed.push(id);
        continue;
      }

      for (const { attachmentId, name } of attachments) {
        console.log(`[mail]   Downloading: ${name}`);
        const data = await downloadAttachment(attachmentId);
        const dest = await resolveTargetPath(name);
        await fs.writeFile(dest, data);
        console.log(`[mail]   Saved to: ${path.relative(ROOT, dest)}`);
        downloaded++;
      }

      await markAsRead(id, changeKey);
      state.processed.push(id);
    }
  }
} catch (err) {
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    console.log(`[mail] Server unreachable (${err.code}) — check network or VPN.`);
    process.exit(0);
  }
  throw err;
}

if (downloaded > 0) {
  state.lastFetchDate = todayIso();
  console.log(`[mail] ${downloaded} PDF(s) saved — polling complete for today.`);
} else {
  console.log('[mail] No PDFs found yet — will check again next hour.');
}

await saveState(state);
