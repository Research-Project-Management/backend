import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import rawZoteroSchema from '../src/modules/library/shared-kernel/data/zotero-schema.json';

export async function seedZoteroFieldMappings(prismaClient?: PrismaClient) {
  let prisma = prismaClient;
  let pool: Pool | null = null;

  if (!prisma) {
    pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ||
        'postgresql://postgres:postgres@localhost:5432/rpm_db?schema=public',
    });
    const adapter = new PrismaPg(pool);
    prisma = new PrismaClient({ adapter });
  }

  const en = (rawZoteroSchema as any).locales?.['en-US']?.fields || {};
  const itemTypes = (rawZoteroSchema as any).itemTypes || [];

  const mappings: Array<{
    itemType: string;
    baseField: string;
    fieldKey: string;
    fieldLabel: string;
    orderIndex: number;
  }> = [];

  for (const it of itemTypes) {
    if (!Array.isArray(it.fields)) continue;
    it.fields.forEach((f: any, idx: number) => {
      const baseField = f.baseField || f.field;
      const fieldKey = f.field;
      const fieldLabel = en[f.field] || f.field;
      mappings.push({
        itemType: it.itemType,
        baseField,
        fieldKey,
        fieldLabel,
        orderIndex: idx,
      });
    });
  }

  console.log(
    `[Zotero Mapping Seeder] Found ${mappings.length} mappings across ${itemTypes.length} item types to sync...`,
  );

  // Batch upsert in chunks of 50
  const chunkSize = 50;
  for (let i = 0; i < mappings.length; i += chunkSize) {
    const chunk = mappings.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map((m) =>
        (prisma as any).itemFieldMapping.upsert({
          where: {
            itemType_baseField: {
              itemType: m.itemType,
              baseField: m.baseField,
            },
          },
          create: m,
          update: {
            fieldKey: m.fieldKey,
            fieldLabel: m.fieldLabel,
            orderIndex: m.orderIndex,
          },
        }),
      ),
    );
  }

  console.log(
    `[Zotero Mapping Seeder] Successfully seeded ${mappings.length} field mappings!`,
  );

  if (pool) {
    await pool.end();
  }
}

if (require.main === module) {
  seedZoteroFieldMappings()
    .then(() => {
      console.log('Seeding finished successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seeding failed:', err);
      process.exit(1);
    });
}
