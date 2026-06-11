import { pool } from '@/lib/db';
import { ReviewClient } from './ReviewClient';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  const result = await pool.query(`
    SELECT id::text, file_name, file_path, detected_date::text, date_source,
           date_confidence, page_count, first_page_preview
    FROM issues WHERE needs_date_review = true ORDER BY file_name
  `);

  return (
    <div className="reviewPage">
      <header className="reviewHeader">
        <div className="brandMark" style={{ fontSize: '18px', width: 32, height: 32 }}>D</div>
        <div>
          <h1 style={{ margin: 0, fontSize: '16px', fontWeight: 700 }}>dikgang — date review</h1>
          <p style={{ margin: 0, fontSize: '12px', color: 'var(--muted)' }}>
            {result.rowCount} issue{result.rowCount !== 1 ? 's' : ''} pending
          </p>
        </div>
      </header>
      <ReviewClient issues={result.rows} />
    </div>
  );
}
