import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import 'dotenv/config';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function verify() {
  try {
    const user = await prisma.user.findFirst({
      where: { email: 'ngotanthanh92.26@gmail.com' },
    });
    if (!user) throw new Error('User not found');

    // 1. Storage files
    const totalFiles = await prisma.file.count({ where: { authorId: user.id } });
    const rootFolders = await prisma.file.findMany({
      where: { authorId: user.id, isFolder: true, parentId: null, trashedAt: null },
      select: { id: true, filename: true },
    });
    const rootFiles = await prisma.file.findMany({
      where: { authorId: user.id, isFolder: false, parentId: null, trashedAt: null },
      select: { id: true, filename: true, size: true, mimeType: true, starred: true },
    });
    const trashedFiles = await prisma.file.findMany({
      where: { authorId: user.id, trashedAt: { not: null } },
      select: { filename: true, trashedAt: true },
    });
    const versions = await prisma.fileVersion.findMany({
      where: { file: { authorId: user.id } },
      select: { fileId: true, versionNumber: true, changeComment: true },
    });
    const shares = await prisma.fileShare.findMany({
      where: { file: { authorId: user.id } },
      include: { user: { select: { email: true } }, file: { select: { filename: true } } },
    });
    const quota = await prisma.storageQuota.findFirst({
      where: { userId: user.id },
    });

    console.log('=== STORAGE VERIFICATION ===');
    console.log('Total files/folders for user:', totalFiles);
    console.log('Root folders:', rootFolders.map((f) => f.filename));
    console.log('Root files:', rootFiles.map((f) => `${f.filename} (${f.size} B, starred: ${f.starred})`));
    console.log('Trashed files count:', trashedFiles.length);
    console.log('Versions count:', versions.length);
    console.log('Shares:', shares.map((s) => `${s.file.filename} -> ${s.user.email} (${s.permission})`));
    console.log('Quota:', quota ? `Used: ${quota.usedBytes} / Max: ${quota.maxBytes}` : 'None');

    // 2. Chat conversations & messages
    const convMembers = await prisma.conversationMember.findMany({
      where: { userId: user.id },
      include: {
        conversation: {
          select: {
            id: true,
            type: true,
            name: true,
            lastSenderName: true,
            lastMessageSnippet: true,
          },
        },
      },
    });

    const totalMessages = await prisma.message.count();
    const totalReactions = await prisma.messageReaction.count();
    const friendships = await prisma.friendship.findMany({
      where: { OR: [{ requesterId: user.id }, { addresseeId: user.id }] },
    });

    console.log('\n=== CHAT VERIFICATION ===');
    console.log('User conversations count:', convMembers.length);
    for (const m of convMembers) {
      console.log(`- [${m.conversation.type}] ${m.conversation.name || 'Direct Chat'}: "${m.conversation.lastMessageSnippet}" (from ${m.conversation.lastSenderName})`);
    }
    console.log('Total chat messages in DB:', totalMessages);
    console.log('Total emoji reactions in DB:', totalReactions);
    console.log('Friendships count:', friendships.length);

    // 3. Recents (Activity Events)
    const recentEvents = await prisma.activityEvent.findMany({
      where: { actorId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    console.log('\n=== RECENTS (ACTIVITY EVENTS) VERIFICATION ===');
    console.log('Total recent activity events for user:', recentEvents.length);
    for (const e of recentEvents) {
      console.log(`- [${e.entityType}] verb: ${e.verb} (id: ${e.entityId}) at ${e.createdAt.toISOString()}`);
    }
  } catch (err) {
    console.error('Error during verification:', err);
  } finally {
    await prisma.$disconnect();
    await pool.end();
    process.exit(0);
  }
}

verify();
