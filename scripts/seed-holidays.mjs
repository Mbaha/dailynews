#!/usr/bin/env node
import Holidays from 'date-holidays';
import pg from 'pg';

const { Client } = pg;
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/dikgang';
const hd = new Holidays('BW');

function yearsFromArgs() {
  const args = process.argv.slice(2).map(Number).filter(Boolean);
  if (args.length) return args;
  const start = Number(process.env.START_YEAR || 2021);
  const end = Number(process.env.END_YEAR || new Date().getFullYear() + 1);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

function isoDayFromHoliday(holiday) {
  // date-holidays returns local-ish strings like "2025-01-01 00:00:00".
  return String(holiday.date).slice(0, 10);
}

const years = yearsFromArgs();
const client = new Client({ connectionString: DATABASE_URL });
await client.connect();

let count = 0;
for (const year of years) {
  for (const holiday of hd.getHolidays(year)) {
    const day = isoDayFromHoliday(holiday);
    const label = holiday.name;
    await client.query(
      `INSERT INTO holidays(day, label, exclude_from_expected_issues)
       VALUES($1, $2, true)
       ON CONFLICT(day) DO UPDATE SET label = EXCLUDED.label`,
      [day, label]
    );
    count++;
  }
}

await client.end();
console.log(`Seeded/updated ${count} Botswana holiday rows for years ${years[0]}-${years[years.length - 1]}`);
