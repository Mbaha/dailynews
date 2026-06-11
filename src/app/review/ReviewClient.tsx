'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Issue = {
  id: string;
  file_name: string;
  file_path: string;
  detected_date: string | null;
  date_source: string | null;
  page_count: number;
  first_page_preview: string | null;
};

function formatHint(issue: Issue): string {
  if (issue.detected_date) return `Auto-detected: ${issue.detected_date} (${issue.date_source})`;
  // Try to guess a date from the filename (e.g. "18 Feb _ 8.pdf" → Feb 18)
  const m = issue.file_name.match(/(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i);
  if (m) return `Filename suggests: ${m[1]} ${m[2]}`;
  return 'No date detected';
}

export function ReviewClient({ issues: initial }: { issues: Issue[] }) {
  const router = useRouter();
  const [issues, setIssues] = useState<Issue[]>(initial);
  const [selected, setSelected] = useState<Issue | null>(initial[0] ?? null);
  const [date, setDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function confirm() {
    if (!selected || !date) return;
    setSaving(true);
    setError('');
    const res = await fetch('/api/review', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: selected.id, date }),
    });
    if (!res.ok) {
      setError('Failed to save date — please try again.');
      setSaving(false);
      return;
    }
    const remaining = issues.filter(i => i.id !== selected.id);
    setIssues(remaining);
    setSelected(remaining[0] ?? null);
    setDate('');
    setSaving(false);
    router.refresh();
  }

  async function discard() {
    if (!selected) return;
    if (!window.confirm(`Delete "${selected.file_name}" from the database and filesystem?`)) return;
    setSaving(true);
    setError('');
    const res = await fetch('/api/review', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: selected.id }),
    });
    if (!res.ok) {
      setError('Failed to delete — please try again.');
      setSaving(false);
      return;
    }
    const remaining = issues.filter(i => i.id !== selected.id);
    setIssues(remaining);
    setSelected(remaining[0] ?? null);
    setDate('');
    setSaving(false);
    router.refresh();
  }

  if (issues.length === 0) {
    return (
      <div className="reviewEmpty">
        <div className="reviewEmptyMark">✓</div>
        <p>No issues pending review. All dates are confirmed.</p>
        <a href="/" className="reviewHomeLink">← Back to archive</a>
      </div>
    );
  }

  return (
    <div className="reviewShell">
      {/* Queue sidebar */}
      <aside className="reviewSidebar">
        <div className="reviewSidebarHead">
          <span>Pending review</span>
          <span className="reviewCount">{issues.length}</span>
        </div>
        <ul className="reviewQueue">
          {issues.map(issue => (
            <li
              key={issue.id}
              className={`reviewQueueItem${selected?.id === issue.id ? ' active' : ''}`}
              onClick={() => { setSelected(issue); setDate(''); setError(''); }}
            >
              <span className="reviewQueueName">{issue.file_name}</span>
              <span className="reviewQueueHint">{formatHint(issue)}</span>
              <span className="reviewQueuePages">{issue.page_count}p</span>
            </li>
          ))}
        </ul>
        <a href="/" className="reviewHomeLink">← Back to archive</a>
      </aside>

      {/* Main panel */}
      {selected && (
        <main className="reviewMain">
          <div className="reviewPdfWrap">
            <iframe
              key={selected.id}
              src={`/api/pdf/${selected.id}`}
              className="reviewPdf"
              title={selected.file_name}
            />
          </div>

          <div className="reviewForm">
            <div className="reviewFormTitle">{selected.file_name}</div>
            <div className="reviewFormHint">{formatHint(selected)}</div>
            {selected.first_page_preview && (
              <pre className="reviewPreview">{selected.first_page_preview.slice(0, 300)}</pre>
            )}

            <label className="reviewLabel" htmlFor="review-date">Confirm publication date</label>
            <input
              id="review-date"
              type="date"
              className="reviewDateInput"
              value={date}
              onChange={e => setDate(e.target.value)}
              disabled={saving}
            />
            {error && <p className="reviewError">{error}</p>}
            <div className="reviewActions">
              <button
                className="reviewConfirmBtn"
                onClick={confirm}
                disabled={!date || saving}
              >
                {saving ? 'Saving…' : 'Confirm date'}
              </button>
              <button
                className="reviewDiscardBtn"
                onClick={discard}
                disabled={saving}
              >
                Delete file
              </button>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
