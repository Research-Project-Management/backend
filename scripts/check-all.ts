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
  const users = await prisma.user.findMany({
    include: { profile: true, projectMembers: { include: { project: true } } },
  });
  console.log('=== USERS ===');
  for (const u of users) {
    console.log(
      `User: ${u.email} (${u.profile?.name}), Projects: ${u.projectMembers.map((m) => `[${m.project.identifier}] ${m.project.name} (${m.role})`).join(', ')}`,
    );
  }

  const projects = await prisma.project.findMany();
  console.log('=== PROJECTS ===');
  for (const p of projects) {
    console.log(
      `Project: [${p.identifier}] ${p.name} (id: ${p.id}, createdById: ${p.createdById})`,
    );
  }
}

run()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
