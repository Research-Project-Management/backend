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

async function run() {
  const projects = await prisma.project.findMany({
    select: { id: true, name: true, identifier: true },
  });

  for (const p of projects) {
    const nodes = await prisma.manuscriptNode.findMany({
      where: { projectId: p.id },
      orderBy: { sortOrder: 'asc' },
    });
    const rootNodes = nodes.filter((n) => n.isRootDoc);
    const docs = await prisma.manuscriptDoc.findMany({
      where: { projectId: p.id },
    });
    console.log(`[${p.identifier}] ${p.name} (${p.id}):`);
    console.log(
      `   Total Nodes: ${nodes.length}, Root Nodes (Pages): ${rootNodes.length}, Total Docs: ${docs.length}`,
    );
    for (const r of rootNodes) {
      console.log(
        `     * ROOT DOC (PAGE): name="${r.name}", path="${r.path}", docId=${r.docId}`,
      );
    }
    for (const n of nodes) {
      console.log(
        `     - Node: "${n.name}", path="${n.path}", type=${n.type}, isRootDoc=${n.isRootDoc}`,
      );
    }
  }
}

run()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
