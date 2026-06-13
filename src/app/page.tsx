import { getArchiveByYear, getIssueById, getIssueToc, getIssuePageText, getNewestIssue } from '@/lib/archive';
import { getGapStatsByYear } from '@/lib/gaps';
import { SearchPanel } from '@/components/SearchPanel';
import { ChatPanel } from '@/components/ChatPanel';
import { PdfViewer } from '@/components/PdfViewer';
import { ReaderShell } from '@/components/ReaderShell';
import { SidebarToggle } from '@/components/SidebarToggle';
import { MobileTabShell } from '@/components/MobileTabShell';
import { TextReader } from '@/components/TextReader';

function formatDate(iso: string | null): string {
  if (!iso) return 'Unknown date';
  const [year, month, day] = iso.split('-');
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${Number(day)} ${months[Number(month) - 1]} ${year}`;
}

export default async function Home({ searchParams }: { searchParams: Promise<{ issue?: string; page?: string }> }) {
  const params = await searchParams;
  const selectedPage = Math.max(1, Number(params.page ?? 1) || 1);
  const newest = await getNewestIssue().catch(() => null);
  const selected = params.issue ? await getIssueById(params.issue).catch(() => null) : null;
  const current = selected ?? newest;
  const [archive, stats, tocItems, pageText] = await Promise.all([
    getArchiveByYear().catch(() => []),
    getGapStatsByYear().catch(() => []),
    current ? getIssueToc(current.id).catch(() => []) : Promise.resolve([]),
    current ? getIssuePageText(current.id, selectedPage).catch(() => null) : Promise.resolve(null),
  ]);
  const pdfSrc = current ? `/api/pdf/${current.id}#page=${selectedPage}&view=FitH` : null;
  const pdfHref = current ? `/api/pdf/${current.id}` : null;

  const newsItems = tocItems.filter((item) => item.category !== 'classified');
  const classifiedItems = tocItems.filter((item) => item.category === 'classified');
  const pageCount = current?.page_count ?? 1;

  return (
    <ReaderShell>
      <header className="siteHeader">
        <SidebarToggle />
        <div className="brandBlock">
          <div className="brandMark">D</div>
          <div>
            <h1>dikgang</h1>
            <p>Botswana Daily News archive</p>
          </div>
        </div>
        <SearchPanel issueId={current?.id ?? null} />
      </header>

      <MobileTabShell>
      <section className="contentGrid">
        <div className="leftRail">
          <div className="infoCard">
            <div className="infoCardHead">{current ? formatDate(current.issue_date) : 'Table of contents'}</div>
            <div className="infoCardBody">
              {current && newsItems.length ? (
                newsItems.map((item, index) => (
                  <a key={`toc-${item.pageNumber}-${index}`} className={selectedPage === item.pageNumber ? 'selected' : ''} href={`/?issue=${current.id}&page=${item.pageNumber}`}>
                    <strong>{item.title}</strong>
                    <span>Page {item.pageNumber}</span>
                  </a>
                ))
              ) : <p className="muted">No articles detected for this issue yet.</p>}
            </div>
          </div>

          <div className="infoCard">
            <div className="infoCardHead">Classifieds &amp; Notices</div>
            <div className="infoCardBody">
              {current && classifiedItems.length > 0 ? (
                classifiedItems.map((item, index) => (
                  <a key={`cls-${item.pageNumber}-${index}`} className={selectedPage === item.pageNumber ? 'selected' : ''} href={`/?issue=${current.id}&page=${item.pageNumber}`}>
                    <strong>{item.title}</strong>
                    <span>Page {item.pageNumber}</span>
                  </a>
                ))
              ) : <p className="muted">No classifieds for this issue.</p>}
            </div>
          </div>

          <div className="infoCard">
            <div className="infoCardHead">Archive</div>
            <div className="infoCardBody">
              {archive.map((group) => (
                <details key={group.year} className="yearGroup" open={group.year === archive[0]?.year}>
                  <summary>{group.year} <span>{group.issues.length}</span></summary>
                  <div className="issueList">
                    {group.issues.map((issue) => (
                      <a key={issue.id} className={current?.id === issue.id ? 'selected' : ''} href={`/?issue=${issue.id}`}>
                        <strong>{formatDate(issue.issue_date)}</strong>
                        <span>{issue.page_count ?? '?'} pages · No. {issue.issue_number ?? '—'}</span>
                      </a>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </div>

          <div className="infoCard">
            <div className="infoCardHead">Year Coverage</div>
            <div className="infoCardBody">
              {stats.length ? stats.map((row) => (
                <details className="gapYear" key={row.year}>
                  <summary>
                    <span>{row.year}</span>
                    <strong>{row.completeness}%</strong>
                  </summary>
                  <div className="gapMeter" aria-label={`${row.completeness}% complete`}>
                    <span style={{ width: `${Math.min(100, row.completeness)}%` }} />
                  </div>
                  <p className="gapLine">
                    {row.present}/{row.expected} issues · {row.missing} missing
                  </p>
                  <div className="missingList">
                    {row.missingDates.length ? row.missingDates.map((missing) => (
                      <span key={missing.day}>{missing.day} · {missing.weekday}</span>
                    )) : <span>No gaps.</span>}
                  </div>
                </details>
              )) : <p className="muted">No statistics yet.</p>}
            </div>
          </div>
        </div>

        <div className="readerPane">
          <div className="readerToolbar">
            {current ? (
              <>
                <a className="toolbarBtn" href={selectedPage > 1 ? `/?issue=${current.id}&page=${selectedPage - 1}` : undefined} aria-disabled={selectedPage <= 1}>← Prev</a>
                <span>{formatDate(current.issue_date)} · {current.file_name} · page {selectedPage} of {pageCount}</span>
                <a className="toolbarBtn" href={selectedPage < pageCount ? `/?issue=${current.id}&page=${selectedPage + 1}` : undefined} aria-disabled={selectedPage >= pageCount}>Next →</a>
              </>
            ) : (
              <span>PDF reader</span>
            )}
          </div>
          <div className="pdfSurface">
            {pdfSrc ? (
              <PdfViewer src={pdfSrc} />
            ) : (
              <div className="pageSurface"><p className="muted">No PDF selected.</p></div>
            )}
          </div>
          {pdfHref && (
            <TextReader text={pageText ?? null} pdfHref={pdfHref} />
          )}
        </div>

        <aside className="rightRail">
          <ChatPanel issueId={current?.id ?? null} />
        </aside>
      </section>
      </MobileTabShell>
    </ReaderShell>
  );
}
