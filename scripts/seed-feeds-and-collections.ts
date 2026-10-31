import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function inspect() {
  const users = await prisma.user.findMany({ include: { profile: true } });
  console.log('USERS:', users.map((u) => ({ id: u.id, email: u.email, name: u.profile?.name })));

  const cols = await prisma.collection.findMany({
    where: { deletedAt: null },
    include: { _count: { select: { collectionItems: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log('COLLECTIONS:', cols.map((c) => ({
    id: c.id,
    name: c.name,
    parentId: c.parentId,
    userId: c.userId,
    projectId: c.projectId,
    items: c._count.collectionItems,
  })));

  const items = await prisma.item.findMany({
    where: { deletedAt: null },
    select: { id: true, title: true, userId: true, projectId: true },
  });
  console.log('ITEMS TOTAL:', items.length);
  console.log('ITEMS BY PROJECT_ID:', items.reduce((acc: Record<string, number>, i) => {
    const k = `${i.userId}::${i.projectId || 'user_library'}`;
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {}));

  const feeds = await prisma.feed.findMany({ include: { _count: { select: { items: true } } } });
  console.log('FEEDS:', feeds);

  const subs = await prisma.feedSubscription.findMany({ include: { feed: true } });
  console.log('SUBSCRIPTIONS:', subs);

  const projects = await prisma.project.findMany();
  console.log('PROJECTS:', projects.map((p) => ({ id: p.id, name: p.name, identifier: p.identifier })));

  await prisma.$disconnect();
  await pool.end();
}

inspect();
