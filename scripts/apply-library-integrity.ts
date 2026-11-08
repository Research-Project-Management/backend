import 'dotenv/config';
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required in environment');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  console.log('🔌 Connected to PostgreSQL for library integrity script execution.');

  try {
    const sqlPath = path.resolve(__dirname, '../prisma/sql/library-schema-integrity.sql');
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');

    console.log('⚡ Executing library-schema-integrity.sql...');
    await client.query(sqlContent);
    console.log('✅ Successfully applied all library integrity constraints, triggers, and partial indexes!');
  } catch (err) {
    console.error('❌ Error applying library integrity script:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
