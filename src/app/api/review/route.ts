import { pool } from '@/lib/db';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

const PAPERS_ROOT = path.join(process.cwd(), 'news-papers');

export async function GET() {
  const result = await pool.query(`
    SELECT id::text, file_name, file_path, detected_date::text, date_source,
           date_confidence, page_count, first_page_preview
    FROM issues WHERE needs_date_review = true ORDER BY file_name
  `);
  return NextResponse.json({ issues: result.rows });
}

export async function PATCH(request: Request) {
  const body = await request.json();
  const id = String(body.id ?? '');
  const date = String(body.date ?? '');
  if (!id || !date) return NextResponse.json({ error: 'id and date required' }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });

  await pool.query(
    `UPDATE issues SET corrected_date=$2, issue_date=$2, needs_date_review=false,
      date_source='manual_review', date_confidence=1.0, updated_at=now() WHERE id=$1`,
    [id, date]
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const body = await request.json();
  const id = String(body.id ?? '');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const result = await pool.query('SELECT file_path FROM issues WHERE id=$1', [id]);
  if (result.rowCount === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });

  await pool.query('DELETE FROM issues WHERE id=$1', [id]);

  // Best-effort file deletion — don't fail the request if the file is already gone
  try {
    const rel = path.relative('news-papers', result.rows[0].file_path);
    const full = path.resolve(PAPERS_ROOT, rel);
    if (full.startsWith(PAPERS_ROOT)) await fs.unlink(full);
  } catch { /* already gone */ }

  return NextResponse.json({ ok: true });
}
