import 'dotenv/config';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const databaseUrl =
    process.env.DATABASE_URL ||
    'postgresql://postgres:Thanh26102006@127.0.0.1:5433/flux-db?schema=public';

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  console.log('🔌 Connected to PostgreSQL for identity integrity script execution.');

  try {
    const sqlPath = path.resolve(__dirname, '../prisma/sql/identity-schema-integrity.sql');
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');

    console.log('⚡ Executing identity-schema-integrity.sql...');
    await client.query(sqlContent);
    console.log('✅ Successfully applied all identity integrity constraints, partial indexes, and check rules!');
  } catch (err) {
    console.error('❌ Error applying identity integrity script:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
