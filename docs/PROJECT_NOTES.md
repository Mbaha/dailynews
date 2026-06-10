# dikgang project notes

Local-first Botswana Daily News archive reader, search, and chat application.

## Confirmed decisions

- App name: **dikgang**.
- Newspaper folder: `/Users/mandersonk/code/javaScript/dailynews/news-papers`.
- Current archive size at initial inspection: **416 PDF files**.
- Publication expectation for gap analysis: **Monday-Friday**.
- Holidays should be excluded from expected issue dates.
- Newspaper: **Botswana Daily News**.
- Search/chat default scope: **full archive**, with toggle for current paper.
- PDFs appear to contain selectable text based on initial `pdftotext` samples.
- Postgres: Homebrew `postgresql@17`.
- pgvector: installed and available as extension version **0.8.2**.
- Ollama models available:
  - `gemma4:latest` for chat
  - `nomic-embed-text:latest` for embeddings

## Initial PDF observations

Sampled PDFs show consistent first-page masthead date lines such as:

- `Wednesday August 9, 2023 No. 141`
- `Tuesday June 10, 2025 No. 107`
- `Wednesday March 1, 2023 No. 033`
- `Monday September 12, 2022 No. 167`
- `Monday November 28, 2022 No. 221`

This suggests issue date should be extracted primarily from first-page text, not filename.

PDF metadata creation date is often one day before issue date and can be used as weak fallback only.

## Proposed date detection order

1. Extract first page text.
2. Find masthead date line using weekday/month/date/year pattern.
3. If missing, use issue number/date clues from page text.
4. If still missing, use filename heuristics.
5. If still ambiguous, mark as `needs_date_review` and show in admin/review UI.

## MVP architecture proposal

- Next.js + React + TypeScript.
- Local web app initially; possible Tauri/native wrapper later.
- PDF viewer using PDF.js/react-pdf.
- Postgres for metadata, extracted text, search indexes, ingestion state, holidays/exclusions.
- pgvector for semantic search embeddings.
- Ollama `nomic-embed-text` for chunk embeddings.
- Ollama `gemma4` for RAG chat with citations.

## Core data entities

- `issues`
  - file path
  - issue date
  - date confidence
  - needs review flag
  - page count
  - PDF hash/size/mtime
  - ingestion status
- `pages`
  - issue id
  - page number
  - extracted page text
- `chunks`
  - issue id
  - page number
  - chunk text
  - optional section/article hint
- `embeddings`
  - chunk id
  - vector
- `holidays`
  - date
  - label
  - whether excluded from expected issues
- `manual_exclusions`
  - date
  - reason
- `ingest_jobs`
  - status
  - started/finished timestamps
  - logs/errors

## Reader UI plan

Default view opens newest confirmed issue.

Sidebar accordions:

1. Current paper TOC
   - MVP: page-based TOC and detected front-page teasers like `Page 6`, `Tsebe 10`, etc.
   - Later: article/section-level TOC if layout parsing improves.
2. Archive by year
   - grouped by issue date
   - date-review/ambiguous files called out separately

## Search plan

- Default scope: Archive.
- Toggle: Archive / Current paper.
- Start with Postgres full-text search and snippets.
- Add vector search with `nomic-embed-text`.
- Final ranking should be hybrid keyword + vector.
- Result click opens the PDF at the matching page.

## Chat plan

- Default scope: Archive.
- Embed question with `nomic-embed-text`.
- Retrieve relevant chunks.
- Send small, cited context to `gemma4`.
- Answer with issue dates and page citations.
- If evidence is weak, answer that the archive does not provide enough support.

## Gap/statistics plan

For each year:

- Expected dates = weekdays minus Botswana public holidays minus manual exclusions.
- Present dates = confirmed ingested issue dates.
- Missing dates = expected minus present.
- UI shows completeness percentage and missing count.
- Click opens scrollable modal/list of missing dates.

Special issues may exist, but should not automatically affect weekday gap expectations unless explicitly configured.

## Mobile/content strategy

Desktop should keep original PDF layout as primary reading mode.

Mobile should prioritize text reading mode:

- article/page text snippets
- search results
- chat citations
- button to open original PDF page when visual context is needed

Ads:

- MVP: index all selectable text.
- Later: classify likely ads and allow user to include/exclude ads from search/chat.

Pictures:

- MVP: preserved in PDF viewer only.
- Later: extract image regions/captions; consider vision model if needed.

Charts/tables:

- MVP: searchable only if text extraction captures them.
- Later: table/chart extraction and source page snapshots.

## Later-development candidates

- Tauri desktop wrapper.
- Multi-user authentication and permissions.
- Hosted/server deployment.
- Mobile-first text/article mode.
- Better article segmentation/layout analysis.
- OCR fallback for scanned or damaged PDFs.
- Liteparse/Docling/Marker/Unstructured evaluation if basic extraction is insufficient.
- PDF bookmark/outline extraction if available.
- Ad detection/classification and ad search toggle.
- Image/caption extraction.
- Chart/table extraction.
- Botswana holiday calendar management UI.
- Manual date-review UI for ambiguous issue dates.
- In-app ingest button and/or watch mode.
- New issue ingestion test using PDFs intentionally left outside the archive.
- Lightweight chat model fallback if `gemma4` is too slow on 8GB RAM.
- Citation previews and page-region highlighting.
- Export search/chat results.

## Inspection pass 1 results

Generated by `scripts/inspect_pdfs.py`.

Reports:

- `reports/pdf-inspection.json`
- `reports/pdf-inspection.md`
- `reports/date-review-candidates.md`

Summary:

- PDFs inspected: 416
- Issue dates detected from first-page masthead: 416
- Extraction/metadata errors: 0
- Duplicate detected issue dates: 3

Duplicate/date-review candidates:

- `2022-07-14`
  - `news-papers/14 July • 2022.pdf`
  - `news-papers/Dailynews 14 July • 2023.pdf`
  - Note: second file appears likely to be a 2023 issue/event but masthead text says 2022; requires review/date correction rule.
- `2023-03-24`
  - `news-papers/DailyNews 31 Mar • Fri 24.pdf`
  - `news-papers/Dailynews Mar 24.pdf`
  - Note: may be an insert/special edition versus regular issue; requires review.
- `2023-06-26`
  - `news-papers/Dailynews 26 June 2023.pdf`
  - `news-papers/Dailynews 27 June 2023.pdf`
  - Note: second filename/creation date suggest June 27, but masthead extracted June 26; requires review/date correction rule.

Ingestion should therefore support duplicate-date review and not silently overwrite or discard issues with same detected date.

## Foundation milestone

Completed initial application/database foundation.

Files added:

- `package.json`
- `next.config.ts`
- `tsconfig.json`
- `src/app/layout.tsx`
- `src/app/page.tsx`
- `src/app/globals.css`
- `src/lib/db.ts`
- `src/lib/archive.ts`
- `src/app/api/pdf/[id]/route.ts`
- `scripts/setup-db.mjs`
- `scripts/ingest.mjs`

Database:

- Created database: `dikgang`
- Enabled extensions: `vector`, `pg_trgm`
- Created tables: `issues`, `pages`, `chunks`, `chunk_embeddings`, `holidays`, `manual_exclusions`, `ingest_jobs`

Initial ingestion results:

- issues: 416
- pages: 7,761
- chunks: 58,682

Newest ingested issue at this milestone:

- `2025-07-24` — `24 July • 16 WDnigh.pdf`

Validation:

- `npm run build` succeeds.

Next recommended implementation steps:

1. Replace placeholder reader area with a PDF.js/react-pdf viewer.
2. Add current/archive keyword search API and UI.
3. Add Botswana holiday seed data and real yearly gap calculations.
4. Add embeddings script using Ollama `nomic-embed-text`.
5. Add RAG chat API using `gemma4` with citations.

## Reader/search milestone

Implemented functional first reader/search iteration.

Added:

- Selectable archive issues via `/?issue=<id>`.
- Page selection via `/?issue=<id>&page=<n>`.
- Embedded PDF reader using browser PDF rendering through `/api/pdf/[id]#page=<n>`.
- Current paper page TOC links.
- Full archive/current paper keyword search UI.
- Search API: `GET /api/search?q=<query>&scope=archive|current&issueId=<id>`.
- Search results link back to the matching issue/page.

Validation:

- `npm run build` succeeds.

Notes:

- This uses the browser's native PDF renderer for the first working reader. A dedicated PDF.js/react-pdf viewer remains a candidate if we need better page event handling, highlights, thumbnails, or mobile text-mode coordination.

## Botswana holiday/gap statistics milestone

Implemented initial yearly archive gap statistics.

Added:

- `date-holidays` dependency for Botswana public holidays.
- `scripts/seed-holidays.mjs`.
- npm command: `npm run seed:holidays`.
- `src/lib/gaps.ts` for expected weekday issue calculations.
- UI year coverage cards with:
  - completeness percentage
  - present/expected count
  - missing count
  - expandable scrollable missing-date list

Seeded Botswana holidays for 2021-2027.

Gap logic:

- Expected dates are Monday-Friday.
- Saturdays/Sundays are excluded.
- Dates in `holidays` with `exclude_from_expected_issues = true` are excluded.
- Dates in `manual_exclusions` are excluded.
- `is_special_issue = true` issues are not counted as normal expected weekday issues.

Validation:

- `npm run build` succeeds.

Later improvements:

- Add holiday/manual-exclusion admin UI.
- Add click-to-modal missing-date list if expandable card is not enough.
- Add per-year duplicate/special issue warnings.
- Confirm whether all `date-holidays` Botswana entries should exclude publication, e.g. Mother's Day when it falls on Sunday is harmless because weekends are already excluded.

## Embeddings/semantic search/chat milestone

Implemented initial Ollama-powered retrieval plumbing.

Added:

- `src/lib/ollama.ts`
- `scripts/embed-chunks.mjs`
- npm command: `npm run embed`
- `GET /api/semantic-search`
- `POST /api/chat`
- Semantic/keyword search mode toggle in UI.
- Working chat panel using retrieved chunks and `gemma4`.

Embedding model:

- `nomic-embed-text:latest`
- Expected vector size: 768
- Stored in `chunk_embeddings.embedding vector(768)`

Chat model:

- `gemma4:latest`

Test run:

- `npm run embed -- --limit=25`
- Result: 25 chunks embedded successfully.
- Remaining at test point: 58,657 chunks.

Important operational note:

- Full archive embedding is resumable but may take time on the M1 MacBook Air.
- Use limited batches first, e.g. `npm run embed -- --limit=1000`.
- Full run: `npm run embed`.
- Issue-specific run: `npm run embed -- --issue=<issue_id>`.

Validation:

- `npm run build` succeeds.

Later improvements:

- Add in-app embedding progress/job UI.
- Add hybrid keyword + vector ranking in one endpoint.
- Add streaming chat responses.
- Add source cards/clickable citations.
- Add context-quality threshold so chat can more confidently say when evidence is weak.

## Hybrid search milestone

Implemented combined keyword + semantic search.

Added:

- `GET /api/hybrid-search`
- Search mode UI now supports:
  - Hybrid
  - Keyword
  - Semantic
- Hybrid is now the default search mode.

Hybrid ranking approach:

- Keyword candidate set from Postgres full-text search.
- Semantic candidate set from pgvector cosine distance over `chunk_embeddings`.
- Candidate sets are merged with reciprocal-rank fusion style scoring.
- Current weighting:
  - keyword RRF: 55%
  - semantic RRF: 45%

Fallback behavior:

- If Ollama embedding fails during hybrid search, endpoint degrades to keyword-only results.
- If only a small portion of archive is embedded, hybrid search still works, but semantic contribution only comes from embedded chunks.

Validation:

- `npm run build` succeeds.

Later improvements:

- Tune keyword/semantic weights after full or larger-batch embeddings.
- Expose weights through configuration.
- Add result badges showing why a result matched: keyword, semantic, or both.
- Add source/page preview side panel.

## Full archive embeddings complete

Completed full embedding of the current archive using `nomic-embed-text:latest`.

Final counts:

- chunks: 58,682
- embeddings: 58,682
- unembedded chunks: 0

Notes:

- The first full run reached the harness timeout after embedding most chunks.
- A second `npm run embed` resumed automatically and completed the remaining 4,588 chunks.
- This confirms the embedding job is resumable.

Validation:

- `npm run build` succeeds after full embeddings.

Impact:

- Semantic search now covers the full archive.
- Hybrid search now combines keyword and semantic signals across the full archive.
- Chat retrieval now has full-archive vector coverage.

## Reader UI refinement milestone

Implemented screenshot-requested reader refinements.

Changed:

- Removed the large `Displayed issue` hero/card component from the main workspace.
- Moved displayed issue context into the PDF reader toolbar.
- Current paper TOC now has its own fixed-height scroll area.
- Current paper TOC now shows extracted article/title candidates rather than only page numbers.
- TOC items still link to the source PDF page.

Notes:

- Article-title extraction is currently heuristic-based from extracted page text.
- It should be tuned after reviewing real issues in the UI.
- Better future option: store detected article/title records during ingestion and optionally allow manual correction.

Validation:

- `npm run build` succeeds.

## Sidebar reading-space refinement

Implemented sidebar refinements from user feedback.

Changed:

- Current paper TOC now occupies approximately two-thirds of sidebar vertical real estate.
- Archive section occupies the remaining third.
- TOC and Archive each scroll internally instead of extending the whole sidebar.
- Added a Hide sidebar / Show sidebar control so the reader can reclaim screen width.
- Removed the `Open PDF` button because the PDF is already visible in the embedded reader.

Validation:

- `npm run build` succeeds.
