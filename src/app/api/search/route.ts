import { pool } from '@/lib/db';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get('q')?.trim() ?? '';
  const scope = url.searchParams.get('scope') === 'current' ? 'current' : 'archive';
  const issueId = url.searchParams.get('issueId');

  if (q.length < 2) return NextResponse.json({ results: [] });

  const params: unknown[] = [q];
  let issueFilter = '';
  if (scope === 'current' && issueId) {
    params.push(issueId);
    issueFilter = `AND i.id = $${params.length}`;
  }

  const elements = await pool.query(`
    WITH query AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
    SELECT
      ('element:' || de.id::text) AS chunk_id,
      'element' AS source_kind,
      de.element_type,
      de.title,
      i.id::text AS issue_id,
      i.issue_date::text,
      i.file_name,
      de.page_number,
      ts_rank_cd(de.search_vector, query.tsq) AS rank,
      CASE
        WHEN de.title IS NOT NULL THEN '<b>' || de.element_type || '</b>: ' || de.title || ' — ' || ts_headline('english', de.text, query.tsq, 'MaxWords=34, MinWords=12, ShortWord=3')
        ELSE '<b>' || de.element_type || '</b>: ' || ts_headline('english', de.text, query.tsq, 'MaxWords=34, MinWords=12, ShortWord=3')
      END AS snippet
    FROM document_elements de
    JOIN issues i ON i.id = de.issue_id
    CROSS JOIN query
    WHERE de.search_vector @@ query.tsq ${issueFilter}
    ORDER BY rank DESC, i.issue_date DESC
    LIMIT 40
  `, params);

  if (elements.rowCount && elements.rowCount > 0) return NextResponse.json({ results: elements.rows, source: 'document_elements' });

  const result = await pool.query(`
    WITH query AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
    SELECT
      ('chunk:' || c.id::text) AS chunk_id,
      'chunk' AS source_kind,
      'chunk' AS element_type,
      NULL::text AS title,
      i.id::text AS issue_id,
      i.issue_date::text,
      i.file_name,
      c.page_number,
      ts_rank_cd(c.search_vector, query.tsq) AS rank,
      ts_headline('english', c.text, query.tsq, 'MaxWords=34, MinWords=12, ShortWord=3') AS snippet
    FROM chunks c
    JOIN issues i ON i.id = c.issue_id
    CROSS JOIN query
    WHERE c.search_vector @@ query.tsq ${issueFilter}
    ORDER BY rank DESC, i.issue_date DESC
    LIMIT 40
  `, params);

  return NextResponse.json({ results: result.rows, source: 'chunks' });
}
