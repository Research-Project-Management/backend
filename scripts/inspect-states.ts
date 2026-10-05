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
  const fluxProject = await prisma.project.findUnique({
    where: { id: '01a106ee-0579-7343-a028-7e9c2a5e8a6b' },
    include: { states: true, workItemLabels: true },
  });
  console.log('FLUX Project states:', fluxProject?.states);
  console.log('FLUX Project labels:', fluxProject?.workItemLabels);

  const pidlProject = await prisma.project.findUnique({
    where: { id: '01a10690-c025-7509-8a6b-718d2b7b8e54' },
    include: { states: true, workItemLabels: true },
  });
  console.log('PIDL Project states:', pidlProject?.states);
  console.log('PIDL Project labels:', pidlProject?.workItemLabels);
}

run()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
