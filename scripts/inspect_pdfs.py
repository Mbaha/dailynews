#!/usr/bin/env python3
"""
Inspect Botswana Daily News PDFs for ingestion readiness.

Requires poppler tools available on PATH:
- pdfinfo
- pdftotext

Outputs:
- reports/pdf-inspection.json
- reports/pdf-inspection.md
"""

from __future__ import annotations

import json
import re
import subprocess
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parents[1]
PAPERS_DIR = ROOT / "news-papers"
REPORTS_DIR = ROOT / "reports"
JSON_REPORT = REPORTS_DIR / "pdf-inspection.json"
MD_REPORT = REPORTS_DIR / "pdf-inspection.md"

MONTHS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "nova": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}

WEEKDAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday"
MONTH_RE = "|".join(sorted(MONTHS.keys(), key=len, reverse=True))

# Main masthead pattern observed in first-page text, e.g.
# Wednesday August 9, 2023 No. 141
MASTHEAD_RE = re.compile(
    rf"\b(?P<weekday>{WEEKDAYS})\s+(?P<month>{MONTH_RE})\s+(?P<day>\d{{1,2}})(?:st|nd|rd|th)?\s*,?\s+(?P<year>20\d{{2}})\b",
    re.IGNORECASE,
)

# Fallback filename-ish pattern, e.g. 01 March 2023, 5 August 2022
DMY_RE = re.compile(
    rf"\b(?P<day>\d{{1,2}})(?:st|nd|rd|th)?\s+(?P<month>{MONTH_RE})\s+(?P<year>20\d{{2}}|\d{{2}})\b",
    re.IGNORECASE,
)

# Fallback filename-ish pattern, e.g. DailyNews 5 Oct, but only when metadata gives year.
DM_NO_YEAR_RE = re.compile(
    rf"\b(?P<day>\d{{1,2}})(?:st|nd|rd|th)?\s+(?P<month>{MONTH_RE})\b",
    re.IGNORECASE,
)

@dataclass
class InspectionResult:
    file: str
    pages: Optional[int]
    issue_date: Optional[str]
    date_source: Optional[str]
    date_confidence: float
    needs_date_review: bool
    matched_text: Optional[str]
    creation_date: Optional[str]
    metadata_year: Optional[int]
    first_text_preview: str
    error: Optional[str]


def run(cmd: list[str], timeout: int = 20) -> str:
    return subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT, timeout=timeout, errors="replace")


def parse_pdfinfo(path: Path) -> tuple[Optional[int], Optional[str], Optional[int], Optional[str]]:
    try:
        info = run(["pdfinfo", str(path)], timeout=10)
    except Exception as exc:
        return None, None, None, f"pdfinfo failed: {exc}"

    pages = None
    creation = None
    metadata_year = None
    for line in info.splitlines():
        if line.startswith("Pages:"):
            try:
                pages = int(line.split(":", 1)[1].strip())
            except ValueError:
                pass
        elif line.startswith("CreationDate:"):
            creation = line.split(":", 1)[1].strip()
            m = re.search(r"\b(20\d{2})\b", creation)
            if m:
                metadata_year = int(m.group(1))
    return pages, creation, metadata_year, None


def first_page_text(path: Path) -> tuple[str, Optional[str]]:
    try:
        text = run(["pdftotext", "-f", "1", "-l", "1", "-layout", str(path), "-"], timeout=20)
        return text, None
    except Exception as exc:
        return "", f"pdftotext failed: {exc}"


def safe_date(year: int, month: int, day: int) -> Optional[date]:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def normalize_year(raw: str) -> int:
    if len(raw) == 2:
        return 2000 + int(raw)
    return int(raw)


def detect_date(path: Path, text: str, metadata_year: Optional[int]) -> tuple[Optional[date], Optional[str], float, Optional[str]]:
    haystacks = [("first_page_masthead", text), ("filename", path.stem)]

    for source, haystack in haystacks:
        m = MASTHEAD_RE.search(haystack)
        if m:
            dt = safe_date(int(m.group("year")), MONTHS[m.group("month").lower()], int(m.group("day")))
            if dt:
                return dt, source, 0.98 if source == "first_page_masthead" else 0.75, m.group(0)

    combined = text[:2000] + "\n" + path.stem
    for source, haystack in [("first_page_date", text[:2000]), ("filename_date", path.stem)]:
        m = DMY_RE.search(haystack)
        if m:
            year = normalize_year(m.group("year"))
            dt = safe_date(year, MONTHS[m.group("month").lower()], int(m.group("day")))
            if dt:
                confidence = 0.82 if source.startswith("first_page") else 0.65
                return dt, source, confidence, m.group(0)

    # Day/month with no year: use creation metadata year as weak fallback.
    if metadata_year:
        for source, haystack in [("filename_day_month_metadata_year", path.stem), ("first_page_day_month_metadata_year", text[:500])]:
            m = DM_NO_YEAR_RE.search(haystack)
            if m:
                dt = safe_date(metadata_year, MONTHS[m.group("month").lower()], int(m.group("day")))
                if dt:
                    return dt, source, 0.45, f"{m.group(0)} + metadata year {metadata_year}"

    return None, None, 0.0, None


def preview(text: str) -> str:
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    lines = [line for line in lines if line]
    return "\n".join(lines[:8])[:1000]


def inspect(path: Path) -> InspectionResult:
    pages, creation, metadata_year, info_error = parse_pdfinfo(path)
    text, text_error = first_page_text(path)
    dt, source, confidence, matched = detect_date(path, text, metadata_year)
    error = "; ".join(e for e in [info_error, text_error] if e) or None
    return InspectionResult(
        file=str(path.relative_to(ROOT)),
        pages=pages,
        issue_date=dt.isoformat() if dt else None,
        date_source=source,
        date_confidence=confidence,
        needs_date_review=(dt is None or confidence < 0.8),
        matched_text=matched,
        creation_date=creation,
        metadata_year=metadata_year,
        first_text_preview=preview(text),
        error=error,
    )


def write_reports(results: list[InspectionResult]) -> None:
    REPORTS_DIR.mkdir(exist_ok=True)
    data = [asdict(r) for r in results]
    JSON_REPORT.write_text(json.dumps(data, indent=2), encoding="utf-8")

    total = len(results)
    errors = [r for r in results if r.error]
    dated = [r for r in results if r.issue_date]
    review = [r for r in results if r.needs_date_review]
    by_source = Counter(r.date_source or "none" for r in results)
    by_year = Counter(r.issue_date[:4] for r in dated)
    date_to_files: dict[str, list[str]] = defaultdict(list)
    for r in dated:
        date_to_files[r.issue_date].append(r.file)
    duplicates = {d: files for d, files in date_to_files.items() if len(files) > 1}

    lines = []
    lines.append("# PDF inspection report")
    lines.append("")
    lines.append(f"Generated: {datetime.now().isoformat(timespec='seconds')}")
    lines.append(f"Archive folder: `{PAPERS_DIR}`")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- PDFs inspected: **{total}**")
    lines.append(f"- Issue dates detected: **{len(dated)}**")
    lines.append(f"- Need date review: **{len(review)}**")
    lines.append(f"- Extraction/metadata errors: **{len(errors)}**")
    lines.append(f"- Duplicate detected issue dates: **{len(duplicates)}**")
    lines.append("")
    lines.append("## Date source counts")
    lines.append("")
    for source, count in by_source.most_common():
        lines.append(f"- `{source}`: {count}")
    lines.append("")
    lines.append("## Detected issues by year")
    lines.append("")
    for year in sorted(by_year):
        lines.append(f"- {year}: {by_year[year]}")
    lines.append("")

    lines.append("## Files needing date review")
    lines.append("")
    if review:
        for r in sorted(review, key=lambda x: x.file):
            lines.append(f"- `{r.file}`")
            lines.append(f"  - guessed date: `{r.issue_date}` source: `{r.date_source}` confidence: `{r.date_confidence}`")
            lines.append(f"  - matched: `{r.matched_text}`")
            lines.append(f"  - creation: `{r.creation_date}`")
    else:
        lines.append("None.")
    lines.append("")

    lines.append("## Duplicate detected issue dates")
    lines.append("")
    if duplicates:
        for d in sorted(duplicates):
            lines.append(f"- {d}")
            for file in duplicates[d]:
                lines.append(f"  - `{file}`")
    else:
        lines.append("None.")
    lines.append("")

    lines.append("## Errors")
    lines.append("")
    if errors:
        for r in errors:
            lines.append(f"- `{r.file}`: {r.error}")
    else:
        lines.append("None.")
    lines.append("")

    MD_REPORT.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    if not PAPERS_DIR.exists():
        raise SystemExit(f"Missing papers directory: {PAPERS_DIR}")
    pdfs = sorted(PAPERS_DIR.rglob("*.pdf"), key=lambda p: p.name.lower())
    results = [inspect(path) for path in pdfs]
    write_reports(results)
    print(f"Inspected {len(results)} PDFs")
    print(f"Wrote {JSON_REPORT}")
    print(f"Wrote {MD_REPORT}")
    review_count = sum(1 for r in results if r.needs_date_review)
    error_count = sum(1 for r in results if r.error)
    print(f"Need date review: {review_count}")
    print(f"Errors: {error_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
