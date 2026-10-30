# DailyNews RAG-Anything ingestion prototype

This module is adapted from the NDP12 RAG-Anything ingestion work. It parses
Daily News newspaper PDFs with RAG-Anything/MinerU in small page batches and
writes normalized JSON for inspection before database import.

## Setup

From the `dailynews` project root:

```bash
npm run raganything:setup
```

This creates `scripts/raganything-ingest/.venv` and installs RAG-Anything.
First runs may download MinerU/parser models.

## Smoke test

Process only the first 2 selected PDFs and first 3 pages per PDF:

```bash
npm run ingest:raganything:test
```

Output:

```text
data/raganything/dailynews-elements-test.json
data/raganything/dailynews-elements-test.stats.json
data/raganything/dailynews-elements-test.manifest.json
data/raganything/raw/
```

## Useful direct commands

Specific file:

```bash
scripts/raganything-ingest/.venv/bin/python scripts/raganything-ingest/ingest.py \
  --files "Daily News 27 November 24.pdf" \
  --max-pages 4 \
  --output data/raganything/one-issue.json
```

More conservative page batches:

```bash
scripts/raganything-ingest/.venv/bin/python scripts/raganything-ingest/ingest.py \
  --limit 1 \
  --max-pages 8 \
  --page-batch-size 2
```

## Notes

- Page arguments are 0-based internally (`--start-page 0` means PDF page 1).
- The script preserves the NDP12 resilience behavior: if MinerU fails on a page
  range, the range is split recursively; only a single bad page is skipped.
- Current output is JSON only. Database import and element embeddings should be
  added after inspecting extraction quality.
