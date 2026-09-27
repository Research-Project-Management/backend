import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:Thanh26102006@127.0.0.1:5433/flux-db?schema=public',
});

async function main() {
  try {
    await pool.query('ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS \'github\'');
    console.log('[Enum Update] Successfully ensured "github" exists in IntegrationProvider enum!');
  } catch (err) {
    console.error('[Enum Update] Error:', err.message);
  } finally {
    await pool.end();
  }
}

main();
