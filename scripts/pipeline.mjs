#!/usr/bin/env node
/**
 * Runs the full ingest → embed pipeline in sequence.
 * Safe to re-run: ingest skips unchanged files (SHA-256), embed skips
 * chunks that already have embeddings.
 *
 * Usage:
 *   node scripts/pipeline.mjs
 *   PAPERS_DIR=/path/to/folder node scripts/pipeline.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPTS = path.join(ROOT, 'scripts');

function run(script, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    console.log(`[pipeline] → ${script}`);
    const proc = spawn(process.execPath, [path.join(SCRIPTS, script)], {
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });
    proc.on('close', (code) => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`[pipeline] ✓ ${script} completed in ${elapsed}s`);
        resolve();
      } else {
        reject(new Error(`${script} exited with code ${code} after ${elapsed}s`));
      }
    });
    proc.on('error', reject);
  });
}

const started = Date.now();
console.log(`[pipeline] Starting at ${new Date().toISOString()}`);

try {
  await run('ingest.mjs');
  await run('embed-chunks.mjs');
  const total = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[pipeline] All done in ${total}s`);
} catch (err) {
  console.error(`[pipeline] Failed: ${err.message}`);
  process.exit(1);
}
