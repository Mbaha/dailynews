#!/usr/bin/env node
/**
 * Watches the news-papers/ folder for new PDFs and automatically triggers
 * the ingest → embed pipeline.
 *
 * - Debounces 4 seconds after the last event (handles multi-event file copies)
 * - Holds /tmp/dikgang-ingest.lock to prevent parallel runs
 * - Cleans up the lock on SIGINT / SIGTERM
 *
 * Usage:
 *   node scripts/watcher.mjs
 *   npm run watch
 */
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAPERS_DIR = process.env.PAPERS_DIR || path.join(ROOT, 'news-papers');
const LOCK_FILE = '/tmp/dikgang-ingest.lock';
const DEBOUNCE_MS = 4000;

let debounceTimer = null;
let running = false;
let pendingRun = false;  // a file arrived while pipeline was running

function log(msg) {
  console.log(`[watcher] ${new Date().toISOString().slice(11, 19)} ${msg}`);
}

async function isLocked() {
  try {
    const pid = await fs.readFile(LOCK_FILE, 'utf8');
    // If the PID in the lock is our own process we're re-entering — that's fine.
    return pid.trim() !== String(process.pid);
  } catch {
    return false;
  }
}

async function acquireLock() {
  await fs.writeFile(LOCK_FILE, String(process.pid));
}

async function releaseLock() {
  try { await fs.unlink(LOCK_FILE); } catch {}
}

async function runPipeline() {
  if (running) {
    log('Pipeline already running — will re-run after it finishes.');
    pendingRun = true;
    return;
  }
  if (await isLocked()) {
    log('Lock file held by another process — skipping trigger.');
    return;
  }

  running = true;
  await acquireLock();
  log('New PDF detected — running pipeline...');

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [path.join(ROOT, 'scripts', 'pipeline.mjs')], {
        stdio: 'inherit',
        env: process.env,
      });
      proc.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`pipeline exited ${code}`))
      );
      proc.on('error', reject);
    });
    log('Pipeline completed successfully.');
  } catch (err) {
    log(`Pipeline failed: ${err.message}`);
  } finally {
    running = false;
    await releaseLock();
    if (pendingRun) {
      pendingRun = false;
      log('Processing files that arrived during the previous run...');
      scheduleRun('(queued)');
    }
  }
}

function scheduleRun(filename) {
  log(`Event: ${filename} — scheduling run in ${DEBOUNCE_MS / 1000}s...`);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runPipeline, DEBOUNCE_MS);
}

async function shutdown() {
  log('Shutting down...');
  if (debounceTimer) clearTimeout(debounceTimer);
  await releaseLock();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Verify the papers directory exists before watching.
try {
  await fs.access(PAPERS_DIR);
} catch {
  console.error(`[watcher] Directory not found: ${PAPERS_DIR}`);
  process.exit(1);
}

log(`Watching ${PAPERS_DIR}`);

// Catch any PDFs dropped while the watcher was not running (e.g. lid closed).
log('Running startup pipeline check...');
runPipeline();

watch(PAPERS_DIR, { recursive: true }, async (eventType, filename) => {
  if (!filename) return;
  if (!filename.toLowerCase().endsWith('.pdf')) return;

  // On macOS 'rename' fires for both create and delete.
  // Check the file actually exists before scheduling.
  if (eventType === 'rename') {
    try {
      await fs.access(path.join(PAPERS_DIR, filename));
    } catch {
      return; // file was deleted, not created
    }
  }

  scheduleRun(filename);
});
