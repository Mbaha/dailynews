import type { QueryResult } from 'pg';
import { pool } from '@/lib/db';
import { EMBED_MODEL, embedText, vectorLiteral } from '@/lib/ollama';
import { chatStream as anthropicChatStream } from '@/lib/anthropic';
import { chatStream as ollamaChatStream } from '@/lib/ollama';
import { NextResponse } from 'next/server';

type RetrievedRow = {
  source_kind: 'element' | 'chunk';
  element_id: string | null;
  issue_id: string;
  issue_date: string;
  file_name: string;
  page_number: number;
  element_type: string;
  title: string | null;
  text: string;
  similarity: string | number;
  score?: string | number;
};

async function retrieveDocumentElements(params: unknown[], issueFilter: string, embeddingLiteral: string | null): Promise<QueryResult<RetrievedRow>> {
  if (!embeddingLiteral) {
    return pool.query<RetrievedRow>(`
      WITH query AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
      SELECT
        'element' AS source_kind,
        de.id::text AS element_id,
        i.id::text AS issue_id,
        i.issue_date::text,
        i.file_name,
        de.page_number,
        de.element_type,
        de.title,
        de.text,
        ts_rank_cd(de.search_vector, query.tsq) AS similarity
      FROM document_elements de
      JOIN issues i ON i.id = de.issue_id
      CROSS JOIN query
      WHERE de.search_vector @@ query.tsq ${issueFilter}
      ORDER BY similarity DESC, i.issue_date DESC
      LIMIT 8
    `, params);
  }

  const elementParams = [...params, embeddingLiteral, EMBED_MODEL];
  const vectorParam = `$${elementParams.length - 1}`;
  const modelParam = `$${elementParams.length}`;
  return pool.query<RetrievedRow>(`
    WITH query AS (SELECT websearch_to_tsquery('english', $1) AS tsq),
    keyword AS (
      SELECT de.id AS element_id,
        ts_rank_cd(de.search_vector, query.tsq) AS keyword_rank,
        row_number() OVER (ORDER BY ts_rank_cd(de.search_vector, query.tsq) DESC) AS kpos
      FROM document_elements de JOIN issues i ON i.id = de.issue_id CROSS JOIN query
      WHERE de.search_vector @@ query.tsq ${issueFilter}
      ORDER BY keyword_rank DESC
      LIMIT 80
    ),
    semantic AS (
      SELECT de.id AS element_id,
        (1 - (e.embedding <=> ${vectorParam}::vector)) AS semantic_similarity,
        row_number() OVER (ORDER BY e.embedding <=> ${vectorParam}::vector) AS spos
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
        (0.55 * COALESCE(1.0 / (60 + k.kpos), 0) + 0.45 * COALESCE(1.0 / (60 + s.spos), 0)) AS score,
        COALESCE(s.semantic_similarity, 0) AS similarity
      FROM keyword k
      FULL OUTER JOIN semantic s ON s.element_id = k.element_id
    )
    SELECT
      'element' AS source_kind,
      de.id::text AS element_id,
      i.id::text AS issue_id,
      i.issue_date::text,
      i.file_name,
      de.page_number,
      de.element_type,
      de.title,
      de.text,
      combined.similarity
    FROM combined
    JOIN document_elements de ON de.id = combined.element_id
    JOIN issues i ON i.id = de.issue_id
    ORDER BY score DESC, i.issue_date DESC
    LIMIT 8
  `, elementParams);
}

async function retrieveLegacyChunks(params: unknown[], issueFilter: string, embeddingLiteral: string | null): Promise<QueryResult<RetrievedRow>> {
  if (!embeddingLiteral) {
    return pool.query<RetrievedRow>(`
      WITH query AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
      SELECT 'chunk' AS source_kind, NULL::text AS element_id, i.id::text AS issue_id, i.issue_date::text, i.file_name,
        c.page_number, 'chunk' AS element_type, NULL::text AS title, c.text,
        ts_rank_cd(c.search_vector, query.tsq) AS similarity
      FROM chunks c
      JOIN issues i ON i.id = c.issue_id
      CROSS JOIN query
      WHERE c.search_vector @@ query.tsq ${issueFilter}
      ORDER BY similarity DESC, i.issue_date DESC
      LIMIT 8
    `, params);
  }

  const chunkParams = [...params, embeddingLiteral, EMBED_MODEL];
  const vp = `$${chunkParams.length - 1}`;
  const mp = `$${chunkParams.length}`;
  return pool.query<RetrievedRow>(`
    WITH query AS (SELECT websearch_to_tsquery('english', $1) AS tsq),
    keyword AS (
      SELECT c.id AS chunk_id,
        ts_rank_cd(c.search_vector, query.tsq) AS keyword_rank,
        row_number() OVER (ORDER BY ts_rank_cd(c.search_vector, query.tsq) DESC) AS kpos
      FROM chunks c JOIN issues i ON i.id = c.issue_id CROSS JOIN query
      WHERE c.search_vector @@ query.tsq ${issueFilter}
      ORDER BY keyword_rank DESC
      LIMIT 80
    ),
    semantic AS (
      SELECT c.id AS chunk_id,
        (1 - (e.embedding <=> ${vp}::vector)) AS semantic_similarity,
        row_number() OVER (ORDER BY e.embedding <=> ${vp}::vector) AS spos
      FROM chunk_embeddings e
      JOIN chunks c ON c.id = e.chunk_id
      JOIN issues i ON i.id = c.issue_id
      WHERE e.model = ${mp} ${issueFilter}
      ORDER BY e.embedding <=> ${vp}::vector
      LIMIT 80
    ),
    combined AS (
      SELECT
        COALESCE(k.chunk_id, s.chunk_id) AS chunk_id,
        (0.55 * COALESCE(1.0 / (60 + k.kpos), 0) + 0.45 * COALESCE(1.0 / (60 + s.spos), 0)) AS score,
        COALESCE(s.semantic_similarity, 0) AS similarity
      FROM keyword k
      FULL OUTER JOIN semantic s ON s.chunk_id = k.chunk_id
    )
    SELECT 'chunk' AS source_kind, NULL::text AS element_id, i.id::text AS issue_id, i.issue_date::text, i.file_name,
      c.page_number, 'chunk' AS element_type, NULL::text AS title, c.text, combined.similarity
    FROM combined
    JOIN chunks c ON c.id = combined.chunk_id
    JOIN issues i ON i.id = c.issue_id
    CROSS JOIN query
    ORDER BY score DESC, i.issue_date DESC
    LIMIT 8
  `, chunkParams);
}

export async function POST(request: Request) {
  const body = await request.json();
  const question = String(body.question ?? '').trim();
  const scope = body.scope === 'current' ? 'current' : 'archive';
  const issueId = body.issueId ? String(body.issueId) : null;
  if (question.length < 3) return NextResponse.json({ error: 'Question is too short' }, { status: 400 });

  // Extract a year mention (e.g. "2025 issues") and use it as a date filter rather than
  // a keyword — otherwise "2025" appears in the tsquery AND clause and confuses ranking.
  const yearMatch = question.match(/\b(20\d{2})\b/);
  const searchText = yearMatch ? question.replace(yearMatch[0], '').replace(/\s+/g, ' ').trim() : question;

  const params: unknown[] = [searchText];
  let issueFilter = '';
  if (yearMatch) {
    params.push(yearMatch[1]);
    issueFilter = `AND EXTRACT(year FROM i.issue_date) = $${params.length}::int`;
  }
  if (scope === 'current' && issueId) {
    params.push(issueId);
    issueFilter += ` AND i.id = $${params.length}`;
  }

  // Try to get an embedding — fall back to keyword-only if Ollama is unavailable.
  let embeddingLiteral: string | null = null;
  try {
    embeddingLiteral = vectorLiteral(await embedText(searchText));
  } catch {
    // Ollama embed unavailable; keyword search will handle it.
  }

  const elementResults = await retrieveDocumentElements(params, issueFilter, embeddingLiteral);
  const chunkResults = await retrieveLegacyChunks(params, issueFilter, embeddingLiteral);

  // RAGAnything coverage is still partial. For archive questions, keep the full
  // legacy chunk index as the backbone and add a couple of document elements as
  // richer citations. Otherwise semantic-only matches from the small
  // document_elements sample can crowd out the real archive hit.
  const rows = chunkResults.rows.length > 0
    ? [...chunkResults.rows.slice(0, 6), ...elementResults.rows.slice(0, 2)]
    : elementResults.rows.slice(0, 8);

  if (rows.length === 0) {
    return NextResponse.json({
      answer: 'No relevant archive passages found for this question. Try rephrasing or use the search panel for keyword results.',
      sources: []
    });
  }

  const sources = rows.map((row, index) => ({
    n: index + 1,
    issue_id: row.issue_id,
    issue_date: row.issue_date,
    file_name: row.file_name,
    page_number: row.page_number,
    similarity: Number(row.similarity),
    source_kind: row.source_kind,
    element_type: row.element_type,
    title: row.title,
  }));

  const context = rows.map((row, index) => {
    const label = row.source_kind === 'element'
      ? `${row.issue_date}, page ${row.page_number}, ${row.file_name}, ${row.element_type}${row.title ? `: ${row.title}` : ''}`
      : `${row.issue_date}, page ${row.page_number}, ${row.file_name}`;
    return `[${index + 1}] ${label}\n${String(row.text).slice(0, 1600)}`;
  }).join('\n\n');

  const prompt = `You are dikgang, a careful assistant for a Botswana Daily News archive.\n\nAnswer the user's question using only the provided newspaper excerpts. Cite sources inline using bracket numbers like [1] or [2]. If the excerpts do not contain enough evidence, say so clearly. Do not invent facts.\n\nWhen the user asks for the "last", "latest", "most recent", or "earliest" reported event, answer that exact date/event first in the opening sentence. Then, if useful, add earlier or related reports as context in a clearly separate paragraph. Do not present older reports as co-equal with the latest one.\n\nQuestion:\n${question}\n\nNewspaper excerpts:\n${context}\n\nAnswer with a concise explanation and a Sources section.`;

  const encoder = new TextEncoder();
  let answerStream: ReadableStream<Uint8Array>;
  let model = 'anthropic';
  try {
    answerStream = await anthropicChatStream(prompt);
  } catch (err) {
    console.warn('[chat] Anthropic unavailable, falling back to Ollama:', (err as Error).message);
    answerStream = await ollamaChatStream(prompt);
    model = 'ollama';
  }

  // Protocol: first line = JSON metadata (sources + model), remainder = raw answer tokens
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify({ sources, model }) + '\n'));
      const reader = answerStream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.enqueue(value);
      }
      controller.close();
    }
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}
