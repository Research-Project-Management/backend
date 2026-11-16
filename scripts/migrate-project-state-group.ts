import 'dotenv/config';
import { Client } from 'pg';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required in environment');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  console.log('🔌 Connected to PostgreSQL.');

  try {
    console.log('⚡ Adding group column and index to project_states...');
    await client.query(`
      ALTER TABLE project_states 
      ADD COLUMN IF NOT EXISTS "group" VARCHAR(50) NOT NULL DEFAULT 'execution';

      CREATE INDEX IF NOT EXISTS idx_project_states_group_seq 
      ON project_states (project_id, "group", sequence);
    `);

    // Backfill any existing states with academic groups
    await client.query(`
      UPDATE project_states SET "group" = 'conception' WHERE name IN ('Ideation', 'Planning');
      UPDATE project_states SET "group" = 'execution' WHERE name IN ('Experimentation', 'Drafting');
      UPDATE project_states SET "group" = 'review' WHERE name IN ('Review');
      UPDATE project_states SET "group" = 'completed' WHERE name IN ('Published');
      UPDATE project_states SET "group" = 'suspended' WHERE name IN ('Paused', 'Cancelled');
    `);

    console.log('✅ Successfully applied project_states group column and updated existing rows!');
  } catch (err) {
    console.error('❌ Error updating project_states table:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
