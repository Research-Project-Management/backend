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

async function check() {
  const pId = '01a1078c-3162-723a-b454-814b8af5f5ec';
  const comments = await prisma.manuscriptCommentThread.count({
    where: { projectId: pId },
  });
  const replies = await prisma.manuscriptCommentReply.count();
  const suggestions = await prisma.manuscriptTrackChange.count({
    where: { projectId: pId },
  });
  const snapshots = await prisma.manuscriptSnapshot.count({
    where: { projectId: pId },
  });
  const labels = await prisma.manuscriptLabel.count({
    where: { projectId: pId },
  });
  const projectLabels = await prisma.projectLabel.count({
    where: { projectId: pId },
  });
  const userLabels = await prisma.label.count();
  const members = await prisma.projectMember.count({
    where: { projectId: pId },
  });
  const libraryItems = await prisma.item.count({ where: { projectId: pId } });
  const storageFiles = await prisma.file.count({ where: { linkedToId: pId } });
  const docs = await prisma.manuscriptDoc.count({ where: { projectId: pId } });
  const rootDocs = await prisma.manuscriptNode.count({
    where: { projectId: pId, isRootDoc: true },
  });

  console.log(
    'DATA_COUNTS:',
    JSON.stringify(
      {
        comments,
        replies,
        suggestions,
        snapshots,
        labels,
        projectLabels,
        userLabels,
        members,
        libraryItems,
        storageFiles,
        docs,
        rootDocs,
      },
      null,
      2,
    ),
  );
}

check()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
