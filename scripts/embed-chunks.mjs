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
const issueId = args.get('issue') || process.env.EMBED_ISSUE_ID;

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

  const params = [MODEL];
  let issueFilter = '';
  if (issueId) {
    params.push(issueId);
    issueFilter = `AND c.issue_id = $${params.length}`;
  }
  const limitSql = limit > 0 ? `LIMIT ${Math.floor(limit)}` : '';

  const chunks = await client.query(`
    SELECT c.id::text, c.text
    FROM chunks c
    LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.model = $1
    WHERE e.chunk_id IS NULL ${issueFilter}
    ORDER BY c.id
    ${limitSql}
  `, params);

  console.log(`Embedding ${chunks.rowCount} chunks with ${MODEL}${limit ? ` (limit ${limit})` : ''}${issueId ? ` for issue ${issueId}` : ''}`);
  const started = Date.now();
  let done = 0;
  for (const row of chunks.rows) {
    const embedding = await embedText(row.text.slice(0, 6000));
    if (embedding.length !== 768) throw new Error(`Expected 768-dim embedding, got ${embedding.length}`);
    await client.query(`
      INSERT INTO chunk_embeddings(chunk_id, model, embedding)
      VALUES($1, $2, $3::vector)
      ON CONFLICT(chunk_id) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding, embedded_at = now()
    `, [row.id, MODEL, vectorLiteral(embedding)]);
    done++;
    if (done % 25 === 0 || done === chunks.rowCount) {
      const elapsed = Math.round((Date.now() - started) / 1000);
      console.log(`Embedded ${done}/${chunks.rowCount} chunks in ${elapsed}s`);
    }
  }

  const remaining = await client.query(`
    SELECT count(*)::int AS remaining
    FROM chunks c
    LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.model = $1
    WHERE e.chunk_id IS NULL
  `, [MODEL]);
  console.log(`Done. Remaining unembedded chunks for ${MODEL}: ${remaining.rows[0].remaining}`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
