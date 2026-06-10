import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { pool } from '@/lib/db';
import { embedText, vectorLiteral, EMBED_MODEL } from '@/lib/ollama';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM = `You are an analytical assistant for the Botswana Daily News (Dikgang) archive.
Answer questions by querying the database using the tools provided. Be precise with numbers and dates.
When asked about repeats or similar items, retrieve the raw data then reason about clusters yourself.
Respond in clear markdown. For tables of data, use markdown tables.

Database schema (PostgreSQL):

  issues(
    id BIGINT PRIMARY KEY,
    issue_date DATE,        -- publication date
    file_name TEXT,         -- original PDF filename
    page_count INT,
    issue_number TEXT
  )

  toc_items(
    id BIGINT PRIMARY KEY,
    issue_id BIGINT REFERENCES issues(id),
    page_number INT,
    title TEXT,             -- headline or ad title extracted by AI
    category TEXT,          -- 'news' or 'classified'
    sort_order INT
  )

  chunks(
    id BIGINT PRIMARY KEY,
    issue_id BIGINT,
    page_number INT,
    text TEXT,              -- raw extracted page text
    search_vector TSVECTOR  -- full-text search: WHERE search_vector @@ plainto_tsquery('english', 'term')
  )

  chunk_embeddings(
    chunk_id BIGINT REFERENCES chunks(id),
    model TEXT,
    embedding vector(768)   -- cosine distance: embedding <=> $1::vector
  )

Archive spans approximately July 2022 to May 2026. Total issues: 403. Total TOC items: ~8716 (4802 news, 3914 classified).`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'sql_query',
    description: 'Run a read-only SELECT query against the archive database. Use for counting, filtering, grouping, aggregating, and trending. A LIMIT 500 is appended automatically unless you specify one.',
    input_schema: {
      type: 'object' as const,
      properties: {
        sql: { type: 'string', description: 'A read-only SELECT query using PostgreSQL syntax' },
        description: { type: 'string', description: 'One sentence: what this query finds' }
      },
      required: ['sql', 'description']
    }
  },
  {
    name: 'semantic_search',
    description: 'Find archive chunks whose content is semantically similar to a phrase — useful when exact keywords are unknown or ads use varied wording. Returns page text and issue metadata.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The concept or example text to search for' },
        limit: { type: 'number', description: 'Max results to return (default 30, max 100)' }
      },
      required: ['query']
    }
  }
];

async function execSql(sql: string): Promise<unknown> {
  const trimmed = sql.trim().replace(/;+$/, '');
  if (!/^SELECT\b/i.test(trimmed)) return { error: 'Only SELECT queries are permitted.' };
  const limited = /\bLIMIT\b/i.test(trimmed) ? trimmed : `${trimmed} LIMIT 500`;
  try {
    const result = await pool.query(limited);
    return { rows: result.rows, rowCount: result.rowCount };
  } catch (err) {
    return { error: String(err) };
  }
}

async function execSemanticSearch(query: string, limit = 30): Promise<unknown> {
  const cap = Math.min(limit, 100);
  try {
    const embedding = await embedText(query);
    const result = await pool.query(`
      SELECT
        c.text AS chunk_text,
        c.page_number,
        i.id   AS issue_id,
        i.issue_date::text,
        i.file_name,
        round((1 - (e.embedding <=> $1::vector))::numeric, 3) AS similarity
      FROM chunk_embeddings e
      JOIN chunks c ON c.id = e.chunk_id
      JOIN issues i ON i.id = c.issue_id
      WHERE e.model = $2
      ORDER BY e.embedding <=> $1::vector
      LIMIT $3
    `, [vectorLiteral(embedding), EMBED_MODEL, cap]);
    return { rows: result.rows, rowCount: result.rowCount };
  } catch (err) {
    return { error: String(err) };
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const question = (body.question ?? '').trim();
  if (question.length < 3) return NextResponse.json({ error: 'Question too short' }, { status: 400 });

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];
  const steps: { tool: string; description: string }[] = [];

  for (let turn = 0; turn < 12; turn++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM,
      tools: TOOLS,
      messages
    });

    if (response.stop_reason === 'end_turn') {
      const answer = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return NextResponse.json({ answer, steps });
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        let result: unknown;

        if (block.name === 'sql_query') {
          const { sql, description } = block.input as { sql: string; description: string };
          steps.push({ tool: 'sql', description });
          result = await execSql(sql);
        } else if (block.name === 'semantic_search') {
          const { query, limit } = block.input as { query: string; limit?: number };
          steps.push({ tool: 'search', description: `Semantic search: "${query}"` });
          result = await execSemanticSearch(query, limit);
        }

        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }

      messages.push({ role: 'user', content: results });
    }
  }

  return NextResponse.json({ error: 'Max tool iterations reached — question may be too complex.' }, { status: 500 });
}
