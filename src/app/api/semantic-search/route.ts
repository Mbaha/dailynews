import { pool } from '@/lib/db';
import { EMBED_MODEL, embedText, vectorLiteral } from '@/lib/ollama';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get('q')?.trim() ?? '';
  const scope = url.searchParams.get('scope') === 'current' ? 'current' : 'archive';
  const issueId = url.searchParams.get('issueId');
  if (q.length < 2) return NextResponse.json({ results: [] });

  const embedding = await embedText(q);
  const params: unknown[] = [vectorLiteral(embedding), EMBED_MODEL];
  let issueFilter = '';
  if (scope === 'current' && issueId) {
    params.push(issueId);
    issueFilter = `AND i.id = $${params.length}`;
  }

  const result = await pool.query(`
    SELECT
      c.id::text AS chunk_id,
      i.id::text AS issue_id,
      i.issue_date::text,
      i.file_name,
      c.page_number,
      c.text AS snippet,
      (1 - (e.embedding <=> $1::vector)) AS similarity
    FROM chunk_embeddings e
    JOIN chunks c ON c.id = e.chunk_id
    JOIN issues i ON i.id = c.issue_id
    WHERE e.model = $2 ${issueFilter}
    ORDER BY e.embedding <=> $1::vector
    LIMIT 24
  `, params);

  return NextResponse.json({ results: result.rows });
}
