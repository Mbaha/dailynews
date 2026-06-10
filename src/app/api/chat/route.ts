import { pool } from '@/lib/db';
import { EMBED_MODEL, embedText, vectorLiteral } from '@/lib/ollama';
import { chatStream } from '@/lib/anthropic';
import { NextResponse } from 'next/server';

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

  // Try to get an embedding — fall back to keyword-only if Ollama is unavailable
  let embeddingLiteral: string | null = null;
  try {
    embeddingLiteral = vectorLiteral(await embedText(searchText));
  } catch {
    // Ollama embed unavailable; keyword search will handle it
  }

  let retrieved;

  if (!embeddingLiteral) {
    // Keyword-only fallback
    retrieved = await pool.query(`
      WITH query AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
      SELECT i.id::text AS issue_id, i.issue_date::text, i.file_name, c.page_number, c.text,
        ts_rank_cd(c.search_vector, query.tsq) AS similarity
      FROM chunks c
      JOIN issues i ON i.id = c.issue_id
      CROSS JOIN query
      WHERE c.search_vector @@ query.tsq ${issueFilter}
      ORDER BY similarity DESC, i.issue_date DESC
      LIMIT 8
    `, params);
  } else {
    // Hybrid: RRF blend of keyword + semantic (same approach as /api/hybrid-search)
    params.push(embeddingLiteral, EMBED_MODEL);
    const vp = `$${params.length - 1}`;
    const mp = `$${params.length}`;
    retrieved = await pool.query(`
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
      SELECT i.id::text AS issue_id, i.issue_date::text, i.file_name, c.page_number, c.text, combined.similarity
      FROM combined
      JOIN chunks c ON c.id = combined.chunk_id
      JOIN issues i ON i.id = c.issue_id
      CROSS JOIN query
      ORDER BY score DESC, i.issue_date DESC
      LIMIT 8
    `, params);
  }

  if (retrieved.rowCount === 0) {
    return NextResponse.json({
      answer: 'No relevant archive passages found for this question. Try rephrasing or use the search panel for keyword results.',
      sources: []
    });
  }

  const sources = retrieved.rows.map((row, index) => ({
    n: index + 1,
    issue_id: row.issue_id,
    issue_date: row.issue_date,
    file_name: row.file_name,
    page_number: row.page_number,
    similarity: Number(row.similarity),
  }));

  const context = retrieved.rows.map((row, index) => (
    `[${index + 1}] ${row.issue_date}, page ${row.page_number}, ${row.file_name}\n${String(row.text).slice(0, 1600)}`
  )).join('\n\n');

  const prompt = `You are dikgang, a careful assistant for a Botswana Daily News archive.\n\nAnswer the user's question using only the provided newspaper excerpts. Cite sources inline using bracket numbers like [1] or [2]. If the excerpts do not contain enough evidence, say so clearly. Do not invent facts.\n\nQuestion:\n${question}\n\nNewspaper excerpts:\n${context}\n\nAnswer with a concise explanation and a Sources section.`;

  const encoder = new TextEncoder();
  const answerStream = await chatStream(prompt);

  // Protocol: first line = JSON metadata (sources), remainder = raw answer tokens
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify({ sources }) + '\n'));
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
