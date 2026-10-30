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

  const elements = await pool.query(`
    SELECT
      ('element:' || de.id::text) AS chunk_id,
      'element' AS source_kind,
      de.element_type,
      de.title,
      i.id::text AS issue_id,
      i.issue_date::text,
      i.file_name,
      de.page_number,
      CASE
        WHEN de.title IS NOT NULL THEN de.element_type || ': ' || de.title || ' — ' || left(de.text, 520)
        ELSE de.element_type || ': ' || left(de.text, 520)
      END AS snippet,
      (1 - (e.embedding <=> $1::vector)) AS similarity
    FROM document_element_embeddings e
    JOIN document_elements de ON de.id = e.element_id
    JOIN issues i ON i.id = de.issue_id
    WHERE e.model = $2 ${issueFilter}
    ORDER BY e.embedding <=> $1::vector
    LIMIT 24
  `, params);

  if (elements.rowCount && elements.rowCount > 0) return NextResponse.json({ results: elements.rows, source: 'document_elements' });

  const result = await pool.query(`
    SELECT
      ('chunk:' || c.id::text) AS chunk_id,
      'chunk' AS source_kind,
      'chunk' AS element_type,
      NULL::text AS title,
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

  return NextResponse.json({ results: result.rows, source: 'chunks' });
}
