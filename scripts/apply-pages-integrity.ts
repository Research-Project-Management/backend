import 'dotenv/config';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const databaseUrl =
    process.env.DIRECT_URL ||
    process.env.DATABASE_URL ||
    'postgresql://postgres:Thanh26102006@127.0.0.1:5433/flux-db?schema=public';

  const args = new Set(process.argv.slice(2));
  const backfillOnly = args.has('--backfill-only');
  const integrityOnly = args.has('--integrity-only');
  const runBackfill = !integrityOnly || backfillOnly;
  const runIntegrity = !backfillOnly;

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  console.log('🔌 Connected to PostgreSQL for pages virtual-tree SQL script execution.');

  try {
    if (runBackfill) {
      const backfillPath = path.resolve(
        __dirname,
        '../prisma/sql/pages-vtree-backfill.sql',
      );
      const backfillSql = fs.readFileSync(backfillPath, 'utf8');
      console.log('⚡ Executing pages-vtree-backfill.sql...');
      await client.query(backfillSql);
      console.log('✅ Successfully applied pages-vtree-backfill.sql!');
    }

    if (runIntegrity) {
      const integrityPath = path.resolve(
        __dirname,
        '../prisma/sql/pages-schema-integrity.sql',
      );
      const integritySql = fs.readFileSync(integrityPath, 'utf8');
      console.log('⚡ Executing pages-schema-integrity.sql...');
      await client.query(integritySql);
      console.log(
        '✅ Successfully applied all pages virtual-tree composite FKs, checks, indexes, and triggers!',
      );
    }
  } catch (err) {
    console.error('❌ Error applying pages virtual-tree SQL script:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
