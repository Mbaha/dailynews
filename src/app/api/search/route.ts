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

  const result = await pool.query(`
    WITH query AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
    SELECT
      c.id::text AS chunk_id,
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

  return NextResponse.json({ results: result.rows });
}
