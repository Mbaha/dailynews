import { pool } from './db';

type HolidayRow = { day: string; label: string };
type PresentRow = { issue_date: string };

export type YearGapStats = {
  year: number;
  expected: number;
  present: number;
  missing: number;
  completeness: number;
  missingDates: { day: string; weekday: string }[];
  holidays: HolidayRow[];
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function getGapStatsByYear(): Promise<YearGapStats[]> {
  const range = await pool.query(`
    SELECT min(EXTRACT(YEAR FROM issue_date))::int AS min_year,
           max(EXTRACT(YEAR FROM issue_date))::int AS max_year
    FROM issues
    WHERE issue_date IS NOT NULL
  `);
  const minYear = range.rows[0]?.min_year;
  const maxYear = range.rows[0]?.max_year;
  if (!minYear || !maxYear) return [];

  const [presentResult, holidayResult, exclusionResult] = await Promise.all([
    pool.query<PresentRow>(`
      SELECT DISTINCT issue_date::text
      FROM issues
      WHERE issue_date IS NOT NULL AND is_special_issue = false
    `),
    pool.query<HolidayRow>(`
      SELECT day::text, label
      FROM holidays
      WHERE exclude_from_expected_issues = true
        AND EXTRACT(YEAR FROM day) BETWEEN $1 AND $2
      ORDER BY day
    `, [minYear, maxYear]),
    pool.query<{ day: string }>(`
      SELECT day::text FROM manual_exclusions
      WHERE EXTRACT(YEAR FROM day) BETWEEN $1 AND $2
    `, [minYear, maxYear])
  ]);

  const present = new Set(presentResult.rows.map((r) => r.issue_date));
  const holidays = new Map(holidayResult.rows.map((r) => [r.day, r.label]));
  const exclusions = new Set(exclusionResult.rows.map((r) => r.day));

  const stats: YearGapStats[] = [];
  for (let year = maxYear; year >= minYear; year--) {
    const expectedDates: string[] = [];
    for (const day of daysInYear(year)) {
      const dow = day.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const iso = toIso(day);
      if (holidays.has(iso) || exclusions.has(iso)) continue;
      expectedDates.push(iso);
    }

    const presentCount = expectedDates.filter((d) => present.has(d)).length;
    const missingDates = expectedDates
      .filter((d) => !present.has(d))
      .map((d) => ({ day: d, weekday: WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()] }));

    const yearHolidays = holidayResult.rows.filter((h) => h.day.startsWith(String(year)));
    stats.push({
      year,
      expected: expectedDates.length,
      present: presentCount,
      missing: missingDates.length,
      completeness: expectedDates.length ? Math.round((presentCount / expectedDates.length) * 1000) / 10 : 0,
      missingDates,
      holidays: yearHolidays
    });
  }
  return stats;
}

function* daysInYear(year: number) {
  let day = new Date(Date.UTC(year, 0, 1));
  while (day.getUTCFullYear() === year) {
    yield new Date(day);
    day.setUTCDate(day.getUTCDate() + 1);
  }
}

function toIso(day: Date) {
  return day.toISOString().slice(0, 10);
}
