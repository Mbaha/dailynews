import { pool } from '@/lib/db';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

const PAPERS_ROOT = path.join(process.cwd(), 'news-papers');

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await pool.query('SELECT file_path, file_name FROM issues WHERE id = $1', [id]);
  if (result.rowCount === 0) return NextResponse.json({ error: 'PDF not found' }, { status: 404 });

  const relativeToPapers = path.relative('news-papers', result.rows[0].file_path);
  const filePath = path.resolve(PAPERS_ROOT, relativeToPapers);
  if (!filePath.startsWith(PAPERS_ROOT)) return NextResponse.json({ error: 'Invalid path' }, { status: 400 });

  const bytes = await fs.readFile(filePath);
  const fileName = String(result.rows[0].file_name);
  const asciiFallback = fileName
    .replaceAll('"', '')
    .replace(/[^\x20-\x7E]/g, '-')
    .slice(0, 180);
  const encodedFileName = encodeURIComponent(fileName).replace(/[()]/g, escape);

  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodedFileName}`
    }
  });
}
