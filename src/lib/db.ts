import pg from 'pg';

const { Pool } = pg;

const globalForPg = globalThis as unknown as { dikgangPool?: pg.Pool };

export const pool = globalForPg.dikgangPool ?? new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://localhost/dikgang'
});

if (process.env.NODE_ENV !== 'production') globalForPg.dikgangPool = pool;
