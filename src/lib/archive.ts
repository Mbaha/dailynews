import { pool } from './db';

export type Issue = {
  id: string;
  file_name: string;
  file_path: string;
  issue_date: string | null;
  page_count: number | null;
  issue_number: string | null;
  needs_date_review: boolean;
  is_special_issue: boolean;
};

const ISSUE_SELECT = `
  SELECT id::text, file_name, file_path, issue_date::text, page_count, issue_number,
    needs_date_review, is_special_issue
  FROM issues
`;

export async function getNewestIssue(): Promise<Issue | null> {
  const result = await pool.query(`${ISSUE_SELECT}
    WHERE issue_date IS NOT NULL
    ORDER BY issue_date DESC, id DESC
    LIMIT 1
  `);
  return result.rows[0] ?? null;
}

export async function getIssueById(id: string): Promise<Issue | null> {
  const result = await pool.query(`${ISSUE_SELECT} WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function getArchiveByYear() {
  const result = await pool.query(`
    SELECT id::text, file_name, file_path, issue_date::text, page_count, issue_number,
      needs_date_review, is_special_issue
    FROM issues
    ORDER BY issue_date DESC NULLS LAST, file_name ASC
  `);
  const years = new Map<string, Issue[]>();
  for (const issue of result.rows as Issue[]) {
    const year = issue.issue_date ? issue.issue_date.slice(0, 4) : 'Needs review';
    if (!years.has(year)) years.set(year, []);
    years.get(year)!.push(issue);
  }
  return [...years.entries()].map(([year, issues]) => ({ year, issues }));
}

export async function getStatsByYear() {
  const result = await pool.query(`
    SELECT EXTRACT(YEAR FROM issue_date)::int AS year, count(*)::int AS present
    FROM issues
    WHERE issue_date IS NOT NULL AND is_special_issue = false
    GROUP BY 1
    ORDER BY 1 DESC
  `);
  return result.rows as { year: number; present: number }[];
}

export type TocItem = {
  title: string;
  pageNumber: number;
  category: string;
};

export async function getIssuePageText(issueId: string, pageNumber: number) {
  const result = await pool.query(
    'SELECT text FROM pages WHERE issue_id = $1 AND page_number = $2',
    [issueId, pageNumber]
  );
  return result.rows[0]?.text as string | undefined;
}

export async function getIssueToc(issueId: string): Promise<TocItem[]> {
  const result = await pool.query(
    `SELECT page_number, title, category
     FROM (
       SELECT DISTINCT ON (title) page_number, title, category, sort_order
       FROM toc_items
       WHERE issue_id = $1
       ORDER BY title, page_number ASC
     ) deduped
     ORDER BY page_number, sort_order`,
    [issueId]
  );
  return result.rows.map((row) => ({
    title: row.title,
    pageNumber: row.page_number,
    category: row.category,
  }));
}
