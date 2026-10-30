#!/usr/bin/env python3
"""
DailyNews RAG-Anything ingestion prototype.

This is adapted from the NDP12 RAG-Anything ingestion module. It parses Daily
News PDFs with RAG-Anything/MinerU in resilient page batches, normalizes the
multimodal content_list output, and writes JSON that can later be imported into
Postgres document_elements.

This script is intentionally file-output first: use it to inspect extraction
quality before wiring results into the app database.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
APP_ROOT = SCRIPT_DIR.parent.parent
DEFAULT_PAPERS_DIR = APP_ROOT / "news-papers"
DEFAULT_OUTPUT = APP_ROOT / "data" / "raganything" / "dailynews-elements-test.json"
DEFAULT_RAW_OUTPUT_DIR = APP_ROOT / "data" / "raganything" / "raw"
DEFAULT_WORKING_DIR = APP_ROOT / "data" / "raganything" / "storage"


@dataclass(frozen=True)
class PdfSpec:
    source_file: str
    filename: str
    path: Path


def compact_ws(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def stable_id(*parts: Any) -> str:
    raw = "::".join(str(p) for p in parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def chunk_text(text: str, size: int, overlap: int) -> list[str]:
    text = compact_ws(text)
    if not text:
        return []
    if len(text) <= size:
        return [text]

    chunks: list[str] = []
    step = max(1, size - overlap)
    start = 0
    while start < len(text):
        end = min(start + size, len(text))
        # Prefer sentence-ish boundaries for long newspaper passages.
        boundary = max(text.rfind(".", start, end), text.rfind("?", start, end), text.rfind("!", start, end))
        if boundary > start + size * 0.55:
            end = boundary + 1
        chunk = text[start:end].strip()
        if len(chunk) >= 40:
            chunks.append(chunk)
        if end == len(text):
            break
        start = max(0, end - overlap)
    return chunks


def first_str(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return " ".join(str(v) for v in value if v is not None)
    return "" if value is None else str(value)


def content_text(item: dict[str, Any]) -> tuple[str, str, str | None]:
    """Return normalized text, normalized element type, optional image path."""
    raw_type = str(item.get("type") or item.get("category") or "generic").lower()
    image_path = item.get("img_path") or item.get("image_path")

    if raw_type in {"footer", "page_number"}:
        return "", "meta", image_path

    if raw_type in {"text", "header", "aside_text"}:
        text = first_str(item.get("text") or item.get("content"))
        return text, "text", image_path

    if raw_type == "table":
        bits = [
            first_str(item.get("table_caption") or item.get("caption")),
            first_str(item.get("table_body") or item.get("text") or item.get("content")),
            first_str(item.get("table_footnote") or item.get("footnote")),
        ]
        return "\n\n".join(b for b in bits if compact_ws(b)), "table", image_path

    if raw_type == "image":
        bits = [
            first_str(item.get("image_caption") or item.get("caption")),
            first_str(item.get("text") or item.get("content")),
            first_str(item.get("image_footnote") or item.get("footnote")),
        ]
        return "\n\n".join(b for b in bits if compact_ws(b)), "image", image_path

    if raw_type in {"equation", "formula"}:
        bits = [first_str(item.get("latex")), first_str(item.get("text") or item.get("content"))]
        return "\n\n".join(b for b in bits if compact_ws(b)), "equation", image_path

    text = first_str(item.get("text") or item.get("content") or item.get("table_body") or item.get("latex"))
    return text, "generic", image_path


def maybe_title(text: str, item_type: str) -> str | None:
    """Heuristic title candidate for UI/citation previews; final classification can improve later."""
    lines = [line.strip() for line in re.split(r"[\n\r]+", text) if line.strip()]
    if not lines:
        return None
    first = compact_ws(lines[0])
    if 8 <= len(first) <= 140 and item_type in {"text", "table", "image"}:
        return first
    return None


def normalize_content_list(
    content_list: list[dict[str, Any]],
    *,
    spec: PdfSpec,
    parser: str,
    parse_method: str,
    chunk_size: int,
    chunk_overlap: int,
    min_text_length: int,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    for item_index, item in enumerate(content_list):
        if not isinstance(item, dict):
            continue

        text, item_type, image_path = content_text(item)
        text = compact_ws(text)
        if not text or len(text) < min_text_length:
            continue

        page_idx = item.get("page_idx", item.get("page", item.get("page_number")))
        page_number: int | None = None
        page_offset = int(item.get("_dailynews_page_offset", 0) or 0)
        if isinstance(page_idx, int):
            # RAG-Anything/MinerU content_list page_idx is 0-based and restarts
            # at 0 in each parsed batch, so add the batch's 0-based page offset.
            page_number = page_offset + page_idx + 1 if page_idx >= 0 else None
        elif isinstance(page_idx, str) and page_idx.isdigit():
            page_number = page_offset + int(page_idx) + 1

        title = maybe_title(text, item_type)
        for chunk_index, chunk in enumerate(chunk_text(text, chunk_size, chunk_overlap)):
            rows.append(
                {
                    "id": stable_id("dailynews-raganything", spec.source_file, item_index, chunk_index, chunk[:80]),
                    "issue_id": None,
                    "issue_date": None,
                    "file_name": spec.filename,
                    "source_file": spec.source_file,
                    "page_number": page_number,
                    "type": item_type,
                    "title": title,
                    "text": chunk,
                    "extractor": "raganything",
                    "parser": parser,
                    "parse_method": parse_method,
                    "item_index": item_index,
                    "chunk_index": chunk_index,
                    "raw_type": item.get("type"),
                    "bbox": item.get("bbox") or item.get("position"),
                    **({"image_path": str(image_path)} if image_path else {}),
                }
            )

    return rows


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def get_page_count(pdf_path: Path) -> int:
    try:
        out = subprocess.check_output(["pdfinfo", str(pdf_path)], text=True, stderr=subprocess.DEVNULL)
        for line in out.splitlines():
            if line.startswith("Pages:"):
                return int(line.split(":", 1)[1].strip())
    except Exception:
        pass
    raise RuntimeError(f"Could not determine PDF page count with pdfinfo: {pdf_path}")


def page_ranges(page_count: int, start_page: int | None, end_page: int | None, max_pages: int | None, batch_size: int) -> list[tuple[int, int]]:
    start = 0 if start_page is None else start_page
    end = page_count - 1 if end_page is None else min(end_page, page_count - 1)
    if max_pages is not None:
        end = min(end, start + max_pages - 1, page_count - 1)
    if start < 0 or end < start:
        raise ValueError(f"Invalid page range: start={start}, end={end}, page_count={page_count}")
    ranges: list[tuple[int, int]] = []
    current = start
    while current <= end:
        batch_end = min(current + batch_size - 1, end)
        ranges.append((current, batch_end))
        current = batch_end + 1
    return ranges


def discover_pdfs(args: argparse.Namespace) -> list[PdfSpec]:
    if args.pdf:
        paths = [Path(p).expanduser() for p in args.pdf]
    else:
        paths = sorted(args.papers_dir.expanduser().rglob("*.pdf"), key=lambda p: str(p).lower())

    if args.files:
        wanted = {name.strip() for name in args.files.split(",") if name.strip()}
        paths = [p for p in paths if p.name in wanted or str(p) in wanted]

    specs: list[PdfSpec] = []
    for path in paths:
        if not path.exists():
            raise FileNotFoundError(path)
        try:
            source_file = str(path.relative_to(APP_ROOT))
        except ValueError:
            source_file = str(path)
        specs.append(PdfSpec(source_file=source_file, filename=path.name, path=path))

    if args.offset:
        specs = specs[args.offset :]
    if args.limit:
        specs = specs[: args.limit]
    if not specs:
        raise FileNotFoundError("No PDF files selected for RAG-Anything ingestion")
    return specs


def write_stats(output: Path, chunks: list[dict[str, Any]]) -> None:
    by_file: dict[str, int] = {}
    by_type: dict[str, int] = {}
    pages_by_file: dict[str, list[int]] = {}
    for c in chunks:
        source = str(c.get("source_file"))
        by_file[source] = by_file.get(source, 0) + 1
        by_type[str(c.get("type"))] = by_type.get(str(c.get("type")), 0) + 1
        page = c.get("page_number")
        if isinstance(page, int):
            pages_by_file.setdefault(source, [])
            if page not in pages_by_file[source]:
                pages_by_file[source].append(page)

    stats = {
        "output": str(output),
        "element_count": len(chunks),
        "by_file": by_file,
        "by_type": by_type,
        "pages_by_file": {k: sorted(v) for k, v in pages_by_file.items()},
        "sample": chunks[:3],
    }
    write_json(output.with_suffix(".stats.json"), stats)


async def parse_with_raganything(args: argparse.Namespace) -> None:
    # RAG-Anything invokes MinerU by subprocess. Ensure the venv bin dir is on PATH
    # when launched from npm as scripts/raganything-ingest/.venv/bin/python.
    path_candidates = [
        str(Path(sys.prefix) / "bin"),
        str(Path(sys.executable).parent),
        str(Path(sys.executable).resolve().parent),
    ]
    os.environ["PATH"] = os.pathsep.join(path_candidates) + os.pathsep + os.environ.get("PATH", "")

    try:
        from raganything import RAGAnything, RAGAnythingConfig
    except ImportError as exc:
        raise SystemExit(
            "raganything is not installed. Run:\n"
            "  npm run raganything:setup\n"
            "or manually:\n"
            "  cd scripts/raganything-ingest\n"
            "  python3 -m venv .venv && source .venv/bin/activate\n"
            "  pip install -r requirements.txt"
        ) from exc

    config = RAGAnythingConfig(
        working_dir=str(args.working_dir),
        parser_output_dir=str(args.raw_output_dir),
        parser=args.parser,
        parse_method=args.parse_method,
        display_content_stats=True,
        enable_image_processing=True,
        enable_table_processing=True,
        enable_equation_processing=True,
    )
    rag = RAGAnything(config=config)

    all_elements: list[dict[str, Any]] = []
    raw_manifests: list[dict[str, Any]] = []

    async def parse_range_resilient(spec: PdfSpec, start: int, end: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Parse a page range. If MinerU fails, split the range; skip only single bad pages."""
        parse_kwargs = {"backend": args.backend, "start_page": start, "end_page": end}
        range_label = f"p{start + 1}-{end + 1}"
        safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "_", Path(spec.filename).stem)[:80]
        try:
            content_list, doc_id = await rag.parse_document(
                file_path=str(spec.path),
                output_dir=str(args.raw_output_dir / safe_name / range_label),
                parse_method=args.parse_method,
                display_stats=True,
                **parse_kwargs,
            )
            for item in content_list:
                if isinstance(item, dict):
                    item["_dailynews_page_offset"] = start
            return content_list, [{"range": range_label, "doc_id": doc_id, "content_items": len(content_list), "status": "ok"}]
        except Exception as exc:
            if start < end:
                mid = (start + end) // 2
                print(f"  MinerU failed on {spec.filename} {range_label}; splitting into p{start + 1}-{mid + 1} and p{mid + 2}-{end + 1}")
                left_items, left_manifest = await parse_range_resilient(spec, start, mid)
                right_items, right_manifest = await parse_range_resilient(spec, mid + 1, end)
                return left_items + right_items, left_manifest + right_manifest

            print(f"  WARNING: skipping {spec.filename} page {start + 1}; MinerU failed: {exc}")
            return [], [{"range": range_label, "content_items": 0, "status": "skipped", "error": str(exc)}]

    specs = discover_pdfs(args)
    print(f"Selected {len(specs)} DailyNews PDF(s) from {args.papers_dir}")

    for spec_index, spec in enumerate(specs, start=1):
        page_count = get_page_count(spec.path)
        ranges = page_ranges(page_count, args.start_page, args.end_page, args.max_pages, args.page_batch_size)
        print(f"\n[{spec_index}/{len(specs)}] Parsing {spec.source_file} ({page_count} pages, {len(ranges)} batch(es))")

        content_list: list[dict[str, Any]] = []
        range_manifest: list[dict[str, Any]] = []
        for start, end in ranges:
            print(f"  Batch pages {start + 1}-{end + 1}")
            items, manifest = await parse_range_resilient(spec, start, end)
            content_list.extend(items)
            range_manifest.extend(manifest)

        safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "_", Path(spec.filename).stem)[:80]
        raw_path = args.raw_output_dir / f"{safe_name}-content-list.json"
        write_json(raw_path, content_list)

        elements = normalize_content_list(
            content_list,
            spec=spec,
            parser=args.parser,
            parse_method=args.parse_method,
            chunk_size=args.chunk_size,
            chunk_overlap=args.chunk_overlap,
            min_text_length=args.min_text_length,
        )
        all_elements.extend(elements)
        raw_manifests.append(
            {
                "source_file": spec.source_file,
                "file_name": spec.filename,
                "raw_content_list": str(raw_path),
                "content_items": len(content_list),
                "normalized_elements": len(elements),
                "ranges": range_manifest,
            }
        )
        print(f"  raw items={len(content_list)} normalized elements={len(elements)}")

    write_json(args.output, all_elements)
    write_stats(args.output, all_elements)
    write_json(args.output.with_suffix(".manifest.json"), raw_manifests)
    print(f"\nWrote DailyNews RAG-Anything JSON: {args.output} ({len(all_elements)} elements)")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Parse DailyNews PDFs with RAG-Anything into normalized JSON")
    parser.add_argument("--papers-dir", type=Path, default=DEFAULT_PAPERS_DIR)
    parser.add_argument("--pdf", type=Path, nargs="*", help="Specific PDF path(s) to parse; bypasses directory discovery")
    parser.add_argument("--files", type=str, default="", help="Comma-separated filenames to select from --papers-dir")
    parser.add_argument("--offset", type=int, default=0, help="Skip this many selected PDFs")
    parser.add_argument("--limit", type=int, default=0, help="Limit selected PDFs; 0 means all")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--raw-output-dir", type=Path, default=DEFAULT_RAW_OUTPUT_DIR)
    parser.add_argument("--working-dir", type=Path, default=DEFAULT_WORKING_DIR)
    parser.add_argument("--parser", choices=["mineru", "docling", "paddleocr"], default="mineru")
    parser.add_argument("--parse-method", choices=["auto", "ocr", "txt"], default="auto")
    parser.add_argument(
        "--backend",
        choices=["pipeline", "vlm-engine", "hybrid-engine", "vlm-http-client", "hybrid-http-client"],
        default="pipeline",
        help="MinerU backend. Default pipeline was most reliable in the NDP12 prototype.",
    )
    parser.add_argument("--start-page", type=int, default=None, help="Optional 0-based start page for smoke tests")
    parser.add_argument("--end-page", type=int, default=None, help="Optional 0-based end page for smoke tests")
    parser.add_argument("--max-pages", type=int, default=None, help="Parse at most this many pages per selected PDF")
    parser.add_argument("--page-batch-size", type=int, default=10, help="Parse PDFs in smaller page batches; failed batches are recursively split")
    parser.add_argument("--chunk-size", type=int, default=1500)
    parser.add_argument("--chunk-overlap", type=int, default=200)
    parser.add_argument("--min-text-length", type=int, default=8, help="Skip tiny text fragments below this length")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.output = args.output if args.output.is_absolute() else APP_ROOT / args.output
    args.raw_output_dir = args.raw_output_dir if args.raw_output_dir.is_absolute() else APP_ROOT / args.raw_output_dir
    args.working_dir = args.working_dir if args.working_dir.is_absolute() else APP_ROOT / args.working_dir
    args.papers_dir = args.papers_dir if args.papers_dir.is_absolute() else APP_ROOT / args.papers_dir

    asyncio.run(parse_with_raganything(args))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
