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
  console.log(
    'Connected to PostgreSQL for files integrity script execution.',
  );

  try {
    const sqlPath = path.resolve(
      __dirname,
      '../prisma/sql/files-schema-integrity.sql',
    );
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');

    console.log('Executing files-schema-integrity.sql...');
    await client.query(sqlContent);
    console.log(
      'Successfully applied all files integrity constraints and partial GC index.',
    );
  } catch (err) {
    console.error('Error applying files integrity script:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

void main();
