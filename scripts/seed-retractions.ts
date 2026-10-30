import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { RetractionRepository } from '../src/modules/library/ingestion/repositories/retraction.repository';
import { RetractionDatabaseService } from '../src/modules/library/ingestion/services/retraction-database.service';
import { RetractionSeederService } from '../src/modules/library/ingestion/services/retraction-seeder.service';
import { SeedRetractionsCommand } from '../src/modules/library/ingestion/commands/seed-retractions.command';

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL environment variable is required');
  return url;
}

async function main() {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter }) as any;

  const repo = new RetractionRepository(prisma);
  const dbService = new RetractionDatabaseService(repo);
  const seeder = new RetractionSeederService(repo, dbService);
  const command = new SeedRetractionsCommand(seeder);

  // Parse CLI args: --file=path/to/file.csv or --url=https://...
  const args = process.argv.slice(2);
  let filePath: string | undefined;
  let url: string | undefined;

  for (const arg of args) {
    if (arg.startsWith('--file=')) {
      filePath = arg.substring('--file='.length);
    } else if (arg.startsWith('--url=')) {
      url = arg.substring('--url='.length);
    }
  }

  console.log('🔄 Starting Retraction Watch Seeder...');
  const result = await command.execute({ filePath, url });
  console.log('✅ Seeding completed successfully:', result);

  await pool.end();
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Seeder failed:', err);
    process.exit(1);
  });
}
