#!/usr/bin/env node
import pg from 'pg';

const { Client } = pg;
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/dikgang';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text:latest';

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  args.set(key, value);
}
const limit = Number(args.get('limit') || process.env.EMBED_LIMIT || 0);

async function embedText(text) {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt: text })
  });
  if (!response.ok) throw new Error(`Ollama embedding failed: ${response.status} ${await response.text()}`);
  const data = await response.json();
  if (!Array.isArray(data.embedding)) throw new Error('No embedding array returned by Ollama');
  return data.embedding;
}

function vectorLiteral(vector) {
  return `[${vector.map((n) => Number(n).toFixed(8)).join(',')}]`;
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const limitSql = limit > 0 ? `LIMIT ${Math.floor(limit)}` : '';
  const result = await client.query(`
    SELECT de.id::text, de.element_type, de.title, de.text, i.issue_date::text, i.file_name, de.page_number
    FROM document_elements de
    JOIN issues i ON i.id = de.issue_id
    LEFT JOIN document_element_embeddings e ON e.element_id = de.id AND e.model = $1
    WHERE e.element_id IS NULL
    ORDER BY de.id
    ${limitSql}
  `, [MODEL]);

  console.log(`Embedding ${result.rowCount} document elements with ${MODEL}${limit ? ` (limit ${limit})` : ''}`);
  const started = Date.now();
  let done = 0;
  for (const row of result.rows) {
    const input = [
      `${row.issue_date || ''} ${row.file_name || ''} page ${row.page_number}`,
      row.element_type,
      row.title || '',
      row.text,
    ].filter(Boolean).join('\n');
    const embedding = await embedText(input.slice(0, 6000));
    if (embedding.length !== 768) throw new Error(`Expected 768-dim embedding, got ${embedding.length}`);
    await client.query(`
      INSERT INTO document_element_embeddings(element_id, model, embedding)
      VALUES($1, $2, $3::vector)
      ON CONFLICT(element_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding, embedded_at = now()
    `, [row.id, MODEL, vectorLiteral(embedding)]);
    done++;
    if (done % 25 === 0 || done === result.rowCount) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      console.log(`Embedded ${done}/${result.rowCount} elements in ${elapsed}s`);
    }
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
