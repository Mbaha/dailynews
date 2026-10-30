#!/usr/bin/env node
import pg from 'pg';

const { Client } = pg;
const DB_NAME = process.env.DIKGANG_DB_NAME || 'dikgang';
const ADMIN_DATABASE_URL = process.env.ADMIN_DATABASE_URL || 'postgres://localhost/postgres';
const DATABASE_URL = process.env.DATABASE_URL || `postgres://localhost/${DB_NAME}`;

async function ensureDatabase() {
  const client = new Client({ connectionString: ADMIN_DATABASE_URL });
  await client.connect();
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
  if (exists.rowCount === 0) {
    await client.query(`CREATE DATABASE ${quoteIdent(DB_NAME)}`);
    console.log(`Created database ${DB_NAME}`);
  } else {
    console.log(`Database ${DB_NAME} already exists`);
  }
  await client.end();
}

function quoteIdent(value) {
  return '"' + value.replaceAll('"', '""') + '"';
}

async function applySchema() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    CREATE TABLE IF NOT EXISTS issues (
      id BIGSERIAL PRIMARY KEY,
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      file_size BIGINT NOT NULL,
      file_mtime TIMESTAMPTZ NOT NULL,
      sha256 TEXT NOT NULL,
      issue_date DATE,
      detected_date DATE,
      corrected_date DATE,
      date_source TEXT,
      date_confidence REAL NOT NULL DEFAULT 0,
      needs_date_review BOOLEAN NOT NULL DEFAULT false,
      is_special_issue BOOLEAN NOT NULL DEFAULT false,
      title TEXT,
      issue_number TEXT,
      page_count INTEGER,
      first_page_preview TEXT,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS issues_issue_date_idx ON issues(issue_date DESC);
    CREATE INDEX IF NOT EXISTS issues_needs_date_review_idx ON issues(needs_date_review);

    CREATE TABLE IF NOT EXISTS pages (
      id BIGSERIAL PRIMARY KEY,
      issue_id BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      page_number INTEGER NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
      UNIQUE(issue_id, page_number)
    );

    CREATE INDEX IF NOT EXISTS pages_search_idx ON pages USING GIN(search_vector);
    CREATE INDEX IF NOT EXISTS pages_text_trgm_idx ON pages USING GIN(text gin_trgm_ops);

    CREATE TABLE IF NOT EXISTS chunks (
      id BIGSERIAL PRIMARY KEY,
      issue_id BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      page_id BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      page_number INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      token_estimate INTEGER NOT NULL DEFAULT 0,
      search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
      UNIQUE(page_id, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS chunks_issue_idx ON chunks(issue_id);
    CREATE INDEX IF NOT EXISTS chunks_search_idx ON chunks USING GIN(search_vector);

    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id BIGINT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      embedding vector(768) NOT NULL,
      embedded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS chunk_embeddings_vector_idx
      ON chunk_embeddings USING hnsw (embedding vector_cosine_ops);

    CREATE TABLE IF NOT EXISTS document_elements (
      id BIGSERIAL PRIMARY KEY,
      external_id TEXT NOT NULL UNIQUE,
      issue_id BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      page_id BIGINT REFERENCES pages(id) ON DELETE SET NULL,
      page_number INTEGER NOT NULL,
      element_type TEXT NOT NULL,
      title TEXT,
      text TEXT NOT NULL,
      bbox JSONB,
      image_path TEXT,
      source_file TEXT NOT NULL,
      extractor TEXT NOT NULL DEFAULT 'raganything',
      parser TEXT,
      parse_method TEXT,
      raw_type TEXT,
      item_index INTEGER,
      chunk_index INTEGER,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(text, ''))) STORED
    );

    CREATE INDEX IF NOT EXISTS document_elements_issue_idx ON document_elements(issue_id, page_number);
    CREATE INDEX IF NOT EXISTS document_elements_type_idx ON document_elements(element_type);
    CREATE INDEX IF NOT EXISTS document_elements_search_idx ON document_elements USING GIN(search_vector);

    CREATE TABLE IF NOT EXISTS document_element_embeddings (
      element_id BIGINT PRIMARY KEY REFERENCES document_elements(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      embedding vector(768) NOT NULL,
      embedded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS document_element_embeddings_vector_idx
      ON document_element_embeddings USING hnsw (embedding vector_cosine_ops);

    CREATE TABLE IF NOT EXISTS holidays (
      day DATE PRIMARY KEY,
      label TEXT NOT NULL,
      exclude_from_expected_issues BOOLEAN NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS manual_exclusions (
      day DATE PRIMARY KEY,
      reason TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS toc_items (
      id BIGSERIAL PRIMARY KEY,
      issue_id BIGINT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
      page_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT 'news'
    );

    CREATE INDEX IF NOT EXISTS toc_items_issue_idx ON toc_items(issue_id, page_number, sort_order);
    CREATE INDEX IF NOT EXISTS toc_items_category_idx ON toc_items(issue_id, category, page_number, sort_order);

    CREATE TABLE IF NOT EXISTS ingest_jobs (
      id BIGSERIAL PRIMARY KEY,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'running',
      message TEXT
    );
  `);
  await client.end();
  console.log('Schema ready');
}

await ensureDatabase();
await applySchema();
