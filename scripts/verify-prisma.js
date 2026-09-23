const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');

async function test() {
  const pool = new Pool({
    connectionString: 'postgresql://postgres:Thanh26102006@127.0.0.1:5433/flux-db?schema=public',
  });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const items = await prisma.item.findMany();
    console.log('✅ Prisma items count:', items.length);

    const collections = await prisma.collection.findMany({
      orderBy: { sortOrder: 'asc' },
    });
    console.log('✅ Prisma collections count:', collections.length);

    const tags = await prisma.tag.findMany();
    console.log('✅ Prisma tags count:', tags.length);

    const retractions = await prisma.retraction.findMany();
    console.log('✅ Prisma retractions count:', retractions.length);

    const collectionItems = await prisma.collectionItem.findMany();
    console.log('✅ Prisma collectionItems count:', collectionItems.length);

    const contributors = await prisma.contributor.findMany();
    console.log('✅ Prisma contributors count:', contributors.length);

    console.log('🎉 ALL PRISMA QUERIES SUCCEEDED!');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

test().catch((e) => {
  console.error('❌ Prisma verification failed:', e);
  process.exit(1);
});
