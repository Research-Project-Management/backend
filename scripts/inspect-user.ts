import 'dotenv/config';
import { PrismaClient, Role, WorkItemPriority } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import Redis from 'ioredis';

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://postgres:Thanh26102006@localhost:5433/flux-db?schema=public',
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function run() {
  console.log('🔍 Inspecting user and projects in database...');
  const user = await prisma.user.findFirst({
    where: { email: 'ngotanthanh92.26@gmail.com' },
    include: { profile: true, projectMembers: { include: { project: true } } },
  });

  if (!user) {
    console.error('❌ User ngotanthanh92.26@gmail.com not found in database!');
    return;
  }

  console.log(
    `✅ Found User: ${user.email} (id: ${user.id}, name: ${user.profile?.name})`,
  );
  console.log(`User memberships (${user.projectMembers.length}):`);
  user.projectMembers.forEach((m) => {
    console.log(
      `  - Project: ${m.project.name} (${m.project.identifier}, id: ${m.project.id}), Role: ${m.role}`,
    );
  });

  const allProjects = await prisma.project.findMany({
    include: {
      states: true,
      _count: { select: { workItems: true } },
    },
  });

  console.log(`All Projects in DB (${allProjects.length}):`);
  allProjects.forEach((p) => {
    console.log(
      `  - [${p.identifier}] ${p.name} (id: ${p.id}) - ${p._count.workItems} work items, ${p.states.length} states`,
    );
  });
}

run()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
