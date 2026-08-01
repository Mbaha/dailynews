# dikgang

**dikgang** is a local-first Botswana Daily News archive reader, search, and chat application. It stores a folder of Daily News PDF editions, extracts text and metadata, builds keyword and vector search indexes, presents the archive in a Next.js reader UI, and can automatically fetch new newspaper PDFs from an Exchange mailbox.

## Project status

- App type: local Next.js + React + TypeScript application
- Archive source: PDF files in `news-papers/`
- Database: PostgreSQL with `pgvector` and `pg_trgm`
- Search: PostgreSQL full-text search plus optional vector/hybrid search
- Chat/RAG: Anthropic by default, with Ollama fallback for local chat
- Automation: macOS `launchd` jobs for mail fetch and PDF-folder watcher

## Main features

- Browse Botswana Daily News issues by year and issue date.
- Read the original PDF in-browser.
- Use a text-first reader mode, especially useful on phones.
- Navigate detected issue contents, including news headlines and classifieds/notices.
- Search the current issue or the full archive.
- Use hybrid search combining keyword relevance and semantic similarity.
- Ask archive questions with source citations.
- Track year-by-year coverage and missing weekday issues.
- Automatically check an Exchange inbox for new Daily News PDF attachments.
- Watch the `news-papers/` folder and ingest newly added PDFs.

## Repository layout

```text
.
├── src/
│   ├── app/                  # Next.js App Router pages and API routes
│   │   ├── api/              # PDF, search, chat, analytics, review endpoints
│   │   ├── review/           # Date-review UI
│   │   ├── globals.css       # Global styling
│   │   ├── layout.tsx        # Root layout
│   │   └── page.tsx          # Main reader page
│   ├── components/           # Reader, search, chat, mobile, and PDF UI components
│   └── lib/                  # Database, archive, gap, Anthropic, and Ollama helpers
├── scripts/                  # Setup, ingest, embedding, mail, watcher, inspection scripts
├── launchd/                  # macOS launchd plist files and wrappers
├── news-papers/              # Local PDF archive; large/source data, not app code
├── docs/                     # Project notes
├── reports/                  # PDF inspection reports
├── package.json              # Node scripts and dependency manifest
└── README.md
```

## Requirements

### System tools

- macOS or another Unix-like environment
- Node.js 26.x recommended; the app was developed with Node `v26.2.0`
- npm
- PostgreSQL, developed with Homebrew `postgresql@17`
- PostgreSQL extensions:
  - `vector` / pgvector
  - `pg_trgm`
- `pdftotext` from Poppler, used by ingestion scripts to extract PDF text
- Optional: Ollama for local embeddings/chat
- Optional: macOS `launchd` for automatic background jobs

### AI services/models

The app can use both cloud and local models:

- Anthropic API
  - Main chat helper: `claude-haiku-4-5`
  - Analytics assistant: `claude-sonnet-4-6`
  - TOC extraction default: `claude-haiku-4-5`
- Ollama
  - Embedding model default: `nomic-embed-text:latest`
  - Chat model default: `gemma4:latest`

## Dependency manifest

Direct runtime dependencies from `package.json` / `package-lock.json`:

| Package | Locked version | Purpose |
|---|---:|---|
| `@anthropic-ai/sdk` | `0.102.0` | Anthropic chat, analytics, and tool-use API client |
| `@types/pg` | `8.20.0` | TypeScript types for `pg`; currently listed under runtime dependencies |
| `date-holidays` | `3.30.2` | Botswana public holiday calculations for mail fetch and coverage logic |
| `httpntlm` | `1.8.13` | NTLM authentication for Exchange Web Services mail fetching |
| `next` | `16.2.7` | Next.js app framework |
| `pg` | `8.21.0` | PostgreSQL client and connection pooling |
| `react` | `19.2.7` | UI library |
| `react-dom` | `19.2.7` | React DOM renderer |
| `react-markdown` | `10.1.0` | Render markdown responses in chat/analytics UI |
| `remark-gfm` | `4.0.1` | GitHub-flavored markdown support |

Direct development dependencies:

| Package | Locked version | Purpose |
|---|---:|---|
| `@types/node` | `25.9.2` | Node.js TypeScript types |
| `@types/react` | `19.2.17` | React TypeScript types |
| `@types/react-dom` | `19.2.3` | React DOM TypeScript types |
| `typescript` | `6.0.3` | TypeScript compiler/language support |

## Environment variables

### App/database environment

These are normally placed in `.env.local` in the project root.

| Variable | Required | Default | Description |
|---|---:|---|---|
| `DATABASE_URL` | Recommended | `postgres://localhost/dikgang` | Main application database connection string |
| `ADMIN_DATABASE_URL` | Setup only | `postgres://localhost/postgres` | Admin connection used by `setup:db` to create the database |
| `DIKGANG_DB_NAME` | Setup only | `dikgang` | Database name to create/use during setup |
| `ANTHROPIC_API_KEY` | Optional but recommended | none | Enables Anthropic chat, analytics, and TOC extraction |
| `ANTHROPIC_TOC_MODEL` | Optional | `claude-haiku-4-5` | Anthropic model used for table-of-contents extraction |
| `OLLAMA_BASE_URL` | Optional | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_EMBED_MODEL` | Optional | `nomic-embed-text:latest` | Embedding model; must produce 768-dimensional embeddings for current schema |
| `OLLAMA_CHAT_MODEL` | Optional | `gemma4:latest` | Local chat model fallback |
| `OLLAMA_TOC_MODEL` | Optional | same as `OLLAMA_CHAT_MODEL` | Local model for TOC extraction fallback |
| `PAPERS_DIR` | Optional | `<project>/news-papers` | Folder containing Daily News PDFs |
| `START_YEAR` | Optional | script-dependent | Holiday seeding start year |
| `END_YEAR` | Optional | script-dependent | Holiday seeding end year |
| `EMBED_LIMIT` | Optional | no fixed default | Limit number of chunks embedded in one run |
| `EMBED_ISSUE_ID` | Optional | all issues | Restrict embedding to one issue |
| `CONCURRENCY` | Optional | script-dependent | TOC backfill concurrency |

### Mail-fetch environment

Mail credentials are intentionally stored outside the repo:

```text
~/.config/dikgang/mail.env
```

Expected keys:

| Variable | Required | Description |
|---|---:|---|
| `MAIL_HOST` | Yes | Exchange/EWS host; script uses `https://MAIL_HOST/EWS/Exchange.asmx` |
| `MAIL_USER` | Yes | Mailbox username, e.g. an email address or `DOMAIN\\user` |
| `MAIL_PASSWORD` | Yes | Mailbox password |
| `MAIL_DOMAIN` | Optional | NTLM domain if not included in `MAIL_USER` |

Do not commit `.env.local` or `~/.config/dikgang/mail.env`.

## npm scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the Next.js development server |
| `npm run build` | Build the production Next.js app |
| `npm run start` | Start the production server after build |
| `npm run setup:db` | Create the database if needed and apply schema |
| `npm run seed:holidays` | Seed Botswana public holidays |
| `npm run ingest` | Extract metadata/text/TOC from PDFs and populate DB |
| `npm run embed` | Embed text chunks into `chunk_embeddings` |
| `npm run pipeline` | Run `ingest` then `embed`; safe to re-run |
| `npm run watch` | Watch `news-papers/` and run pipeline on new PDFs |
| `npm run backfill-toc` | Re-extract/backfill TOC items |
| `npm run mail:fetch` | Poll Exchange inbox for new Daily News PDFs |
| `npm run inspect:pdfs` | Generate PDF inspection reports |

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Ensure PostgreSQL is running and `pgvector` is installed.

3. Create `.env.local` with at least:

   ```env
   DATABASE_URL=postgres://localhost/dikgang
   ANTHROPIC_API_KEY=your_key_if_using_anthropic
   OLLAMA_BASE_URL=http://localhost:11434
   OLLAMA_EMBED_MODEL=nomic-embed-text:latest
   OLLAMA_CHAT_MODEL=gemma4:latest
   ```

4. Set up the database:

   ```bash
   npm run setup:db
   npm run seed:holidays
   ```

5. Ingest the archive:

   ```bash
   npm run pipeline
   ```

6. Start the app:

   ```bash
   npm run dev
   ```

7. Open the local Next.js URL shown in the terminal, usually `http://localhost:3000`.

## Automatic newspaper download

The mail fetch script checks Exchange Web Services for unread emails from:

```text
op-pr-office@gov.bw
```

It downloads PDF attachments for messages whose subject appears to be Daily News, saves them into `news-papers/`, moves processed mail to Deleted Items, and stores state in:

```text
~/.config/dikgang/mail-state.json
```

The script skips weekends and Botswana public holidays. It also skips once a newspaper has already been fetched for the current date.

Manual run:

```bash
npm run mail:fetch
```

macOS launchd files:

| File | Purpose |
|---|---|
| `launchd/com.dikgang.mail.plist` | Poll mail every hour |
| `launchd/mail-fetch.sh` | Loads NVM and `~/.config/dikgang/mail.env`, then runs mail fetch |
| `launchd/com.dikgang.watcher.plist` | Keep the folder watcher running |
| `launchd/watcher.sh` | Starts the watcher with environment loaded |

Typical launchd install for mail fetch:

```bash
mkdir -p ~/Library/LaunchAgents ~/Library/Logs
cp launchd/com.dikgang.mail.plist ~/Library/LaunchAgents/com.dikgang.mail.plist
launchctl load ~/Library/LaunchAgents/com.dikgang.mail.plist
launchctl start com.dikgang.mail
```

Check logs:

```bash
tail -80 ~/Library/Logs/dikgang-mail.log
```

## Data flow

```text
PDFs in news-papers/
  ↓
scripts/ingest.mjs
  - calculates file metadata and SHA-256
  - extracts first-page date and issue number
  - extracts text by page using pdftotext
  - creates text chunks
  - extracts TOC/news/classified items using Anthropic or Ollama
  ↓
PostgreSQL tables: issues, pages, chunks, toc_items
  ↓
scripts/embed-chunks.mjs
  - sends chunk text to Ollama embeddings
  ↓
PostgreSQL table: chunk_embeddings
  ↓
Next.js app/API
  - PDF reading
  - archive navigation
  - keyword/hybrid/semantic search
  - cited chat answers
  - analytics assistant
```

## API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/pdf/[id]` | `GET` | Streams the selected issue PDF inline |
| `/api/search` | `GET` | Keyword full-text search over chunks |
| `/api/semantic-search` | `GET` | Semantic search over embeddings |
| `/api/hybrid-search` | `GET` | Blended keyword + semantic search |
| `/api/chat` | `POST` | RAG chat over retrieved archive chunks |
| `/api/analytics` | `POST` | Anthropic tool-use assistant for database analysis |
| `/api/review` | `GET`/`POST` | Date-review workflow for ambiguous issues |

## Data dictionary

### `issues`

One row per PDF issue.

| Column | Type | Required | Description |
|---|---|---:|---|
| `id` | `BIGSERIAL` | Yes | Primary key |
| `file_path` | `TEXT` | Yes | Relative or stored path to PDF; unique |
| `file_name` | `TEXT` | Yes | Original PDF filename |
| `file_size` | `BIGINT` | Yes | File size in bytes at ingest time |
| `file_mtime` | `TIMESTAMPTZ` | Yes | File modification timestamp |
| `sha256` | `TEXT` | Yes | SHA-256 hash used to detect changed files |
| `issue_date` | `DATE` | No | Final publication date used by the app |
| `detected_date` | `DATE` | No | Automatically detected date, usually from masthead text |
| `corrected_date` | `DATE` | No | Manual override date from review workflow |
| `date_source` | `TEXT` | No | Source/method used to identify the date |
| `date_confidence` | `REAL` | Yes | Confidence score for date extraction; default `0` |
| `needs_date_review` | `BOOLEAN` | Yes | Whether issue requires manual date review |
| `is_special_issue` | `BOOLEAN` | Yes | Exclude from ordinary weekday coverage expectations if true |
| `title` | `TEXT` | No | Optional issue title/label |
| `issue_number` | `TEXT` | No | Newspaper issue number extracted from masthead, e.g. `No. 107` |
| `page_count` | `INTEGER` | No | Number of pages detected/extracted |
| `first_page_preview` | `TEXT` | No | Preview text from first page for review/debugging |
| `ingested_at` | `TIMESTAMPTZ` | Yes | First ingest timestamp |
| `updated_at` | `TIMESTAMPTZ` | Yes | Last update timestamp |

Indexes:

- `issues_issue_date_idx` on `issue_date DESC`
- `issues_needs_date_review_idx` on `needs_date_review`

### `pages`

One row per extracted PDF page.

| Column | Type | Required | Description |
|---|---|---:|---|
| `id` | `BIGSERIAL` | Yes | Primary key |
| `issue_id` | `BIGINT` | Yes | Foreign key to `issues.id`; cascades on delete |
| `page_number` | `INTEGER` | Yes | One-based page number within the PDF |
| `text` | `TEXT` | Yes | Raw extracted page text; defaults to empty string |
| `search_vector` | `TSVECTOR` | Generated | English full-text search vector generated from `text` |

Constraints/indexes:

- Unique: `(issue_id, page_number)`
- `pages_search_idx` GIN index on `search_vector`
- `pages_text_trgm_idx` GIN trigram index on `text`

### `chunks`

Search/RAG chunks derived from page text.

| Column | Type | Required | Description |
|---|---|---:|---|
| `id` | `BIGSERIAL` | Yes | Primary key |
| `issue_id` | `BIGINT` | Yes | Foreign key to `issues.id`; cascades on delete |
| `page_id` | `BIGINT` | Yes | Foreign key to `pages.id`; cascades on delete |
| `page_number` | `INTEGER` | Yes | Page number copied for faster retrieval/display |
| `chunk_index` | `INTEGER` | Yes | Zero/one-based sequence within the page, depending on ingest implementation |
| `text` | `TEXT` | Yes | Chunk text used for search, embeddings, and chat context |
| `token_estimate` | `INTEGER` | Yes | Approximate token count; default `0` |
| `search_vector` | `TSVECTOR` | Generated | English full-text search vector generated from `text` |

Constraints/indexes:

- Unique: `(page_id, chunk_index)`
- `chunks_issue_idx` on `issue_id`
- `chunks_search_idx` GIN index on `search_vector`

### `chunk_embeddings`

Vector embeddings for chunks.

| Column | Type | Required | Description |
|---|---|---:|---|
| `chunk_id` | `BIGINT` | Yes | Primary key and foreign key to `chunks.id`; cascades on delete |
| `model` | `TEXT` | Yes | Embedding model name used, e.g. `nomic-embed-text:latest` |
| `embedding` | `vector(768)` | Yes | 768-dimensional embedding vector |
| `embedded_at` | `TIMESTAMPTZ` | Yes | Embedding creation timestamp |

Indexes:

- `chunk_embeddings_vector_idx` HNSW index using cosine distance

Important: if changing to an embedding model that does not output 768 dimensions, update this column definition and re-embed chunks.

### `holidays`

Public holidays excluded from expected newspaper issue dates.

| Column | Type | Required | Description |
|---|---|---:|---|
| `day` | `DATE` | Yes | Primary key holiday date |
| `label` | `TEXT` | Yes | Holiday name |
| `exclude_from_expected_issues` | `BOOLEAN` | Yes | If true, coverage gap logic does not expect an issue on this date |

### `manual_exclusions`

Manual non-publication dates to exclude from coverage calculations.

| Column | Type | Required | Description |
|---|---|---:|---|
| `day` | `DATE` | Yes | Primary key excluded date |
| `reason` | `TEXT` | Yes | Human-readable reason for excluding the date |

### `toc_items`

Detected contents for each issue, including news headlines and classifieds/notices.

| Column | Type | Required | Description |
|---|---|---:|---|
| `id` | `BIGSERIAL` | Yes | Primary key |
| `issue_id` | `BIGINT` | Yes | Foreign key to `issues.id`; cascades on delete |
| `page_number` | `INTEGER` | Yes | Page where the item appears |
| `title` | `TEXT` | Yes | Detected headline, ad title, tender, notice, etc. |
| `sort_order` | `INTEGER` | Yes | Ordering within page/issue; default `0` |
| `category` | `TEXT` | Yes | `news` or `classified`; default `news` |

Indexes:

- `toc_items_issue_idx` on `(issue_id, page_number, sort_order)`
- `toc_items_category_idx` on `(issue_id, category, page_number, sort_order)`

### `ingest_jobs`

High-level ingest job records.

| Column | Type | Required | Description |
|---|---|---:|---|
| `id` | `BIGSERIAL` | Yes | Primary key |
| `started_at` | `TIMESTAMPTZ` | Yes | Job start timestamp |
| `finished_at` | `TIMESTAMPTZ` | No | Job finish timestamp |
| `status` | `TEXT` | Yes | Job status; default `running` |
| `message` | `TEXT` | No | Optional job message/error details |

## Coverage/gap logic

Coverage statistics compare:

```text
expected dates = weekdays in each year
                 minus Botswana public holidays
                 minus manual exclusions
```

against confirmed `issues.issue_date` values where `is_special_issue = false`.

Special issues can remain in the archive while being excluded from regular weekday completeness percentages.

## Operational notes

- `npm run pipeline` is designed to be safe to re-run.
- Ingest skips unchanged files using SHA-256 and file metadata.
- Embedding skips chunks that already have embeddings for the configured model.
- The watcher uses `/tmp/dikgang-ingest.lock` to avoid overlapping pipeline runs.
- Mail fetch saves state in `~/.config/dikgang/mail-state.json`.
- The web app does not itself download newspapers; background mail fetch handles downloads, and the watcher/pipeline handles ingestion.

## Security and privacy

- Keep API keys and mail credentials out of Git.
- Do not commit `.env.local`, `~/.config/dikgang/mail.env`, logs, or local database dumps.
- The archive PDFs may contain copyrighted or sensitive source material; treat `news-papers/` as local source data unless explicitly cleared for sharing.

## GitHub

Repository remote:

```text
https://github.com/Mbaha/dailynews.git
```
