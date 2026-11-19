import 'dotenv/config';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const databaseUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DIRECT_URL or DATABASE_URL is required in environment');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  console.log('Connected to PostgreSQL for experiments URL backfill.');

  try {
    const sqlPath = path.resolve(
      __dirname,
      '../prisma/sql/experiments-url-backfill.sql',
    );
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');

    console.log('Executing experiments-url-backfill.sql...');
    await client.query(sqlContent);
    console.log('Successfully applied legacy URL backfill migration.');
  } catch (err) {
    console.error('Error applying experiments URL backfill:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
