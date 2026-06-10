import { pool } from '@/lib/db';
import { EMBED_MODEL, embedText, vectorLiteral } from '@/lib/ollama';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get('q')?.trim() ?? '';
  const scope = url.searchParams.get('scope') === 'current' ? 'current' : 'archive';
  const issueId = url.searchParams.get('issueId');
  if (q.length < 2) return NextResponse.json({ results: [] });

  let embeddingLiteral: string | null = null;
  try {
    embeddingLiteral = vectorLiteral(await embedText(q));
  } catch (error) {
    console.warn('Hybrid search embedding failed; falling back to keyword-only results.', error);
  }

  const params: unknown[] = [q];
  let issueFilter = '';
  if (scope === 'current' && issueId) {
    params.push(issueId);
    issueFilter = `AND i.id = $${params.length}`;
  }

  if (!embeddingLiteral) {
    const fallback = await pool.query(`
      WITH query AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
      SELECT
        c.id::text AS chunk_id,
        i.id::text AS issue_id,
        i.issue_date::text,
        i.file_name,
        c.page_number,
        ts_rank_cd(c.search_vector, query.tsq) AS score,
        ts_rank_cd(c.search_vector, query.tsq) AS keyword_rank,
        0::real AS semantic_similarity,
        ts_headline('english', c.text, query.tsq, 'MaxWords=38, MinWords=14, ShortWord=3') AS snippet
      FROM chunks c
      JOIN issues i ON i.id = c.issue_id
      CROSS JOIN query
      WHERE c.search_vector @@ query.tsq ${issueFilter}
      ORDER BY score DESC, i.issue_date DESC
      LIMIT 40
    `, params);
    return NextResponse.json({ results: fallback.rows, degraded: true });
  }

  params.push(embeddingLiteral, EMBED_MODEL);
  const vectorParam = `$${params.length - 1}`;
  const modelParam = `$${params.length}`;

  const result = await pool.query(`
    WITH query AS (
      SELECT websearch_to_tsquery('english', $1) AS tsq
    ),
    keyword AS (
      SELECT
        c.id AS chunk_id,
        ts_rank_cd(c.search_vector, query.tsq) AS keyword_rank,
        row_number() OVER (ORDER BY ts_rank_cd(c.search_vector, query.tsq) DESC) AS keyword_position
      FROM chunks c
      JOIN issues i ON i.id = c.issue_id
      CROSS JOIN query
      WHERE c.search_vector @@ query.tsq ${issueFilter}
      ORDER BY keyword_rank DESC
      LIMIT 80
    ),
    semantic AS (
      SELECT
        c.id AS chunk_id,
        (1 - (e.embedding <=> ${vectorParam}::vector)) AS semantic_similarity,
        row_number() OVER (ORDER BY e.embedding <=> ${vectorParam}::vector) AS semantic_position
      FROM chunk_embeddings e
      JOIN chunks c ON c.id = e.chunk_id
      JOIN issues i ON i.id = c.issue_id
      WHERE e.model = ${modelParam} ${issueFilter}
      ORDER BY e.embedding <=> ${vectorParam}::vector
      LIMIT 80
    ),
    combined AS (
      SELECT
        COALESCE(k.chunk_id, s.chunk_id) AS chunk_id,
        COALESCE(k.keyword_rank, 0) AS keyword_rank,
        COALESCE(s.semantic_similarity, 0) AS semantic_similarity,
        COALESCE(1.0 / (60 + k.keyword_position), 0) AS keyword_rrf,
        COALESCE(1.0 / (60 + s.semantic_position), 0) AS semantic_rrf
      FROM keyword k
      FULL OUTER JOIN semantic s ON s.chunk_id = k.chunk_id
    )
    SELECT
      c.id::text AS chunk_id,
      i.id::text AS issue_id,
      i.issue_date::text,
      i.file_name,
      c.page_number,
      combined.keyword_rank,
      combined.semantic_similarity,
      ((0.55 * combined.keyword_rrf) + (0.45 * combined.semantic_rrf)) AS score,
      CASE
        WHEN combined.keyword_rank > 0 THEN ts_headline('english', c.text, query.tsq, 'MaxWords=38, MinWords=14, ShortWord=3')
        ELSE left(c.text, 520)
      END AS snippet
    FROM combined
    JOIN chunks c ON c.id = combined.chunk_id
    JOIN issues i ON i.id = c.issue_id
    CROSS JOIN query
    ORDER BY score DESC, i.issue_date DESC
    LIMIT 40
  `, params);

  return NextResponse.json({ results: result.rows, degraded: false });
}
