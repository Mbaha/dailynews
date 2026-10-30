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

  const elementResults = embeddingLiteral
    ? await hybridElements(params, issueFilter, embeddingLiteral)
    : await keywordElements(params, issueFilter);

  if (elementResults.rowCount && elementResults.rowCount > 0) {
    return NextResponse.json({ results: elementResults.rows, degraded: !embeddingLiteral, source: 'document_elements' });
  }

  const chunkResults = embeddingLiteral
    ? await hybridChunks(params, issueFilter, embeddingLiteral)
    : await keywordChunks(params, issueFilter);
  return NextResponse.json({ results: chunkResults.rows, degraded: !embeddingLiteral, source: 'chunks' });
}

function keywordElements(params: unknown[], issueFilter: string) {
  return pool.query(`
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
      ts_rank_cd(de.search_vector, query.tsq) AS score,
      ts_rank_cd(de.search_vector, query.tsq) AS keyword_rank,
      0::real AS semantic_similarity,
      CASE
        WHEN de.title IS NOT NULL THEN '<b>' || de.element_type || '</b>: ' || de.title || ' — ' || ts_headline('english', de.text, query.tsq, 'MaxWords=38, MinWords=14, ShortWord=3')
        ELSE '<b>' || de.element_type || '</b>: ' || ts_headline('english', de.text, query.tsq, 'MaxWords=38, MinWords=14, ShortWord=3')
      END AS snippet
    FROM document_elements de
    JOIN issues i ON i.id = de.issue_id
    CROSS JOIN query
    WHERE de.search_vector @@ query.tsq ${issueFilter}
    ORDER BY score DESC, i.issue_date DESC
    LIMIT 40
  `, params);
}

function hybridElements(params: unknown[], issueFilter: string, embeddingLiteral: string) {
  const elementParams = [...params, embeddingLiteral, EMBED_MODEL];
  const vectorParam = `$${elementParams.length - 1}`;
  const modelParam = `$${elementParams.length}`;
  return pool.query(`
    WITH query AS (SELECT websearch_to_tsquery('english', $1) AS tsq),
    keyword AS (
      SELECT de.id AS element_id,
        ts_rank_cd(de.search_vector, query.tsq) AS keyword_rank,
        row_number() OVER (ORDER BY ts_rank_cd(de.search_vector, query.tsq) DESC) AS keyword_position
      FROM document_elements de
      JOIN issues i ON i.id = de.issue_id
      CROSS JOIN query
      WHERE de.search_vector @@ query.tsq ${issueFilter}
      ORDER BY keyword_rank DESC
      LIMIT 80
    ),
    semantic AS (
      SELECT de.id AS element_id,
        (1 - (e.embedding <=> ${vectorParam}::vector)) AS semantic_similarity,
        row_number() OVER (ORDER BY e.embedding <=> ${vectorParam}::vector) AS semantic_position
      FROM document_element_embeddings e
      JOIN document_elements de ON de.id = e.element_id
      JOIN issues i ON i.id = de.issue_id
      WHERE e.model = ${modelParam} ${issueFilter}
      ORDER BY e.embedding <=> ${vectorParam}::vector
      LIMIT 80
    ),
    combined AS (
      SELECT
        COALESCE(k.element_id, s.element_id) AS element_id,
        COALESCE(k.keyword_rank, 0) AS keyword_rank,
        COALESCE(s.semantic_similarity, 0) AS semantic_similarity,
        COALESCE(1.0 / (60 + k.keyword_position), 0) AS keyword_rrf,
        COALESCE(1.0 / (60 + s.semantic_position), 0) AS semantic_rrf
      FROM keyword k
      FULL OUTER JOIN semantic s ON s.element_id = k.element_id
    )
    SELECT
      ('element:' || de.id::text) AS chunk_id,
      'element' AS source_kind,
      de.element_type,
      de.title,
      i.id::text AS issue_id,
      i.issue_date::text,
      i.file_name,
      de.page_number,
      combined.keyword_rank,
      combined.semantic_similarity,
      ((0.55 * combined.keyword_rrf) + (0.45 * combined.semantic_rrf)) AS score,
      CASE
        WHEN combined.keyword_rank > 0 AND de.title IS NOT NULL THEN '<b>' || de.element_type || '</b>: ' || de.title || ' — ' || ts_headline('english', de.text, query.tsq, 'MaxWords=38, MinWords=14, ShortWord=3')
        WHEN combined.keyword_rank > 0 THEN '<b>' || de.element_type || '</b>: ' || ts_headline('english', de.text, query.tsq, 'MaxWords=38, MinWords=14, ShortWord=3')
        WHEN de.title IS NOT NULL THEN de.element_type || ': ' || de.title || ' — ' || left(de.text, 520)
        ELSE de.element_type || ': ' || left(de.text, 520)
      END AS snippet
    FROM combined
    JOIN document_elements de ON de.id = combined.element_id
    JOIN issues i ON i.id = de.issue_id
    CROSS JOIN query
    ORDER BY score DESC, i.issue_date DESC
    LIMIT 40
  `, elementParams);
}

function keywordChunks(params: unknown[], issueFilter: string) {
  return pool.query(`
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
}

function hybridChunks(params: unknown[], issueFilter: string, embeddingLiteral: string) {
  const chunkParams = [...params, embeddingLiteral, EMBED_MODEL];
  const vectorParam = `$${chunkParams.length - 1}`;
  const modelParam = `$${chunkParams.length}`;
  return pool.query(`
    WITH query AS (SELECT websearch_to_tsquery('english', $1) AS tsq),
    keyword AS (
      SELECT c.id AS chunk_id,
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
      SELECT c.id AS chunk_id,
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
      ('chunk:' || c.id::text) AS chunk_id,
      'chunk' AS source_kind,
      'chunk' AS element_type,
      NULL::text AS title,
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
  `, chunkParams);
}
