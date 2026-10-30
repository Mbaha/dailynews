#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/dikgang';
const input = process.argv[2] || process.env.RAGANYTHING_ELEMENTS_FILE || 'data/raganything/dailynews-elements-test.json';
const INPUT_PATH = path.isAbsolute(input) ? input : path.join(ROOT, input);

function asJson(value) {
  return value == null ? null : JSON.stringify(value);
}

async function main() {
  const raw = await fs.readFile(INPUT_PATH, 'utf8');
  const elements = JSON.parse(raw);
  if (!Array.isArray(elements)) throw new Error(`Expected JSON array in ${INPUT_PATH}`);

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  let imported = 0;
  let skipped = 0;
  let missingIssue = 0;

  await client.query('BEGIN');
  try {
    for (const el of elements) {
      const sourceFile = String(el.source_file || '').trim();
      const pageNumber = Number(el.page_number || 0);
      const text = String(el.text || '').trim();
      if (!el.id || !sourceFile || !pageNumber || !text) {
        skipped++;
        continue;
      }

      const issue = await client.query(
        'SELECT id FROM issues WHERE file_path=$1 OR file_name=$2 LIMIT 1',
        [sourceFile, el.file_name || path.basename(sourceFile)]
      );
      if (!issue.rowCount) {
        missingIssue++;
        skipped++;
        continue;
      }
      const issueId = issue.rows[0].id;

      const page = await client.query(
        'SELECT id FROM pages WHERE issue_id=$1 AND page_number=$2 LIMIT 1',
        [issueId, pageNumber]
      );
      const pageId = page.rowCount ? page.rows[0].id : null;

      await client.query(`
        INSERT INTO document_elements(
          external_id, issue_id, page_id, page_number, element_type, title, text,
          bbox, image_path, source_file, extractor, parser, parse_method, raw_type,
          item_index, chunk_index, metadata
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
        ON CONFLICT(external_id) DO UPDATE SET
          issue_id=EXCLUDED.issue_id,
          page_id=EXCLUDED.page_id,
          page_number=EXCLUDED.page_number,
          element_type=EXCLUDED.element_type,
          title=EXCLUDED.title,
          text=EXCLUDED.text,
          bbox=EXCLUDED.bbox,
          image_path=EXCLUDED.image_path,
          source_file=EXCLUDED.source_file,
          extractor=EXCLUDED.extractor,
          parser=EXCLUDED.parser,
          parse_method=EXCLUDED.parse_method,
          raw_type=EXCLUDED.raw_type,
          item_index=EXCLUDED.item_index,
          chunk_index=EXCLUDED.chunk_index,
          metadata=EXCLUDED.metadata,
          imported_at=now()
      `, [
        el.id,
        issueId,
        pageId,
        pageNumber,
        el.type || 'text',
        el.title || null,
        text,
        asJson(el.bbox),
        el.image_path || null,
        sourceFile,
        el.extractor || 'raganything',
        el.parser || null,
        el.parse_method || null,
        el.raw_type || null,
        Number.isFinite(Number(el.item_index)) ? Number(el.item_index) : null,
        Number.isFinite(Number(el.chunk_index)) ? Number(el.chunk_index) : null,
        JSON.stringify({ file_name: el.file_name || null, issue_date: el.issue_date || null }),
      ]);
      imported++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }

  console.log(`Imported ${imported} document elements from ${INPUT_PATH}`);
  console.log(`Skipped ${skipped}${missingIssue ? ` (${missingIssue} missing matching issue rows — run npm run ingest first)` : ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
