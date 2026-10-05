import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://postgres:Thanh26102006@localhost:5433/flux-db?schema=public',
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function verify() {
  const projectId = '01a1074d-115c-7296-a400-27e3a8074889';
  const rootNodes = await prisma.manuscriptNode.findMany({
    where: {
      projectId,
      isRootDoc: true,
      OR: [{ docId: null }, { doc: { deleted: false } }],
    },
    include: { doc: true },
    orderBy: { sortOrder: 'asc' },
  });

  console.log(`Verified ${rootNodes.length} Root Document Pages:`);
  for (const n of rootNodes) {
    console.log(
      `- Page ID: ${n.docId}, Title: "${n.name}", Path: "${n.path}", Lines: ${Array.isArray(n.doc?.lines) ? n.doc.lines.length : 0}`,
    );
  }
}

verify()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
