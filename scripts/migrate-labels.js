const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Checking existing columns in labels table...');
  const cols = await prisma.$queryRaw`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'labels'
  `;
  console.log('Current columns:', cols.map(c => c.column_name));

  const existingCols = new Set(cols.map(c => c.column_name));

  if (!existingCols.has('description')) {
    console.log('Adding description column...');
    await prisma.$executeRawUnsafe(`ALTER TABLE "labels" ADD COLUMN "description" TEXT;`);
  }

  if (!existingCols.has('sort_order')) {
    console.log('Adding sort_order column...');
    await prisma.$executeRawUnsafe(`ALTER TABLE "labels" ADD COLUMN "sort_order" DOUBLE PRECISION NOT NULL DEFAULT 65535;`);
  }

  if (!existingCols.has('parent_id')) {
    console.log('Adding parent_id column...');
    await prisma.$executeRawUnsafe(`ALTER TABLE "labels" ADD COLUMN "parent_id" UUID REFERENCES "labels"("id") ON DELETE CASCADE;`);
  }

  if (!existingCols.has('project_id')) {
    console.log('Adding project_id column...');
    await prisma.$executeRawUnsafe(`ALTER TABLE "labels" ADD COLUMN "project_id" UUID REFERENCES "projects"("id") ON DELETE CASCADE;`);
  }

  console.log('Creating indices...');
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "labels_project_id_sort_order_idx" ON "labels"("project_id", "sort_order");`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "labels_project_id_parent_id_idx" ON "labels"("project_id", "parent_id");`);

  console.log('Migration completed successfully!');
}

main()
  .catch(err => {
    console.error('Migration error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
