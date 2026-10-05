import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
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
  console.log(
    '🔄 Updating user name to "Tấn Thành" across the entire database...',
  );

  // 1. Update user profile
  const user = await prisma.user.findFirst({
    where: { email: 'ngotanthanh92.26@gmail.com' },
    include: { profile: true },
  });

  if (user) {
    await prisma.userProfile.update({
      where: { userId: user.id },
      data: {
        name: 'Tấn Thành',
        institution:
          'Flux Laboratory for Neural Computing & Scientific AI (Lab Director)',
      },
    });
    console.log(
      `✅ Updated User Profile: Name = "Tấn Thành", Institution = "Flux Laboratory for Neural Computing & Scientific AI (Lab Director)"`,
    );
  }

  // 2. Update Project Description
  const fluxProject = await prisma.project.findFirst({
    where: { identifier: 'FLUX' },
  });
  if (fluxProject) {
    await prisma.project.update({
      where: { id: fluxProject.id },
      data: {
        description:
          'Phòng Thí Nghiệm Trọng Điểm Trí Tuệ Nhân Tạo & Tính Toán Khoa Học (Flux Lab). Chủ nhiệm Lab: Tấn Thành. Lĩnh vực nghiên cứu: Physics-Informed Neural Operators (PINO/FNO), High-Performance GPU Computing, và Mô hình hóa dòng chảy rối Navier-Stokes.',
      },
    });
    console.log('✅ Updated FLUX Project description.');
  }

  // 3. Update Manuscript Docs lines
  const docs = await prisma.manuscriptDoc.findMany({
    where: { projectId: fluxProject?.id },
  });

  for (const doc of docs) {
    let content = Array.isArray(doc.lines)
      ? (doc.lines as string[]).join('\n')
      : String(doc.lines);
    let modified = false;

    if (content.includes('GS. TS. Ngô Tấn Thành')) {
      content = content.replaceAll('GS. TS. Ngô Tấn Thành', 'Tấn Thành');
      modified = true;
    }
    if (content.includes('GS. Tấn Thành')) {
      content = content.replaceAll('GS. Tấn Thành', 'Tấn Thành');
      modified = true;
    }
    if (content.includes('Prof.~Tan~Thanh~Ngo')) {
      content = content.replaceAll('Prof.~Tan~Thanh~Ngo', 'Tan~Thanh');
      modified = true;
    }
    if (content.includes('Prof. Tan Thanh Ngo')) {
      content = content.replaceAll('Prof. Tan Thanh Ngo', 'Tan Thanh');
      modified = true;
    }

    if (modified) {
      const lines = content.split('\n');
      await prisma.manuscriptDoc.update({
        where: { id: doc.id },
        data: {
          lines,
          sizeBytes: Buffer.byteLength(content, 'utf8'),
        },
      });
      console.log(`✅ Updated manuscript doc: ${doc.path}`);
    }
  }

  // 4. Update Work Items title and content
  const workItems = await prisma.workItem.findMany({
    where: { projectId: fluxProject?.id },
  });

  for (const item of workItems) {
    let title = item.title;
    let content = item.content || '';
    let modified = false;

    if (
      title.includes('GS. TS. Ngô Tấn Thành') ||
      title.includes('GS. Tấn Thành')
    ) {
      title = title
        .replaceAll('GS. TS. Ngô Tấn Thành', 'Tấn Thành')
        .replaceAll('GS. Tấn Thành', 'Tấn Thành');
      modified = true;
    }
    if (
      content.includes('GS. TS. Ngô Tấn Thành') ||
      content.includes('GS. Tấn Thành')
    ) {
      content = content
        .replaceAll('GS. TS. Ngô Tấn Thành', 'Tấn Thành')
        .replaceAll('GS. Tấn Thành', 'Tấn Thành');
      modified = true;
    }

    if (modified) {
      await prisma.workItem.update({
        where: { id: item.id },
        data: { title, content },
      });
      console.log(`✅ Updated Work Item: ${item.identifier}`);
    }
  }

  // 5. Update Comments
  const comments = await prisma.workItemComment.findMany({
    where: { workItem: { projectId: fluxProject?.id } },
  });
  for (const c of comments) {
    if (
      c.content.includes('GS. TS. Ngô Tấn Thành') ||
      c.content.includes('GS. Tấn Thành')
    ) {
      const content = c.content
        .replaceAll('GS. TS. Ngô Tấn Thành', 'Tấn Thành')
        .replaceAll('GS. Tấn Thành', 'Tấn Thành');
      await prisma.workItemComment.update({
        where: { id: c.id },
        data: { content },
      });
      console.log(`✅ Updated Work Item Comment: ${c.id}`);
    }
  }

  // 6. Update Stickies
  if (user) {
    const stickies = await prisma.sticky.findMany({
      where: { userId: user.id },
    });
    for (const s of stickies) {
      if (
        s.content.includes('GS. TS. Ngô Tấn Thành') ||
        s.content.includes('GS. Tấn Thành')
      ) {
        const content = s.content
          .replaceAll('GS. TS. Ngô Tấn Thành', 'Tấn Thành')
          .replaceAll('GS. Tấn Thành', 'Tấn Thành');
        await prisma.sticky.update({
          where: { id: s.id },
          data: { content },
        });
        console.log(`✅ Updated Sticky: ${s.title}`);
      }
    }
  }

  // 7. Flush Redis Cache
  try {
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    const keys = await redis.keys('*');
    const targetKeys = keys.filter(
      (k) =>
        k.includes('doc') ||
        k.includes('page') ||
        k.includes('user') ||
        k.includes('profile') ||
        k.includes('work-item') ||
        k.includes('flux:wi') ||
        k.includes('project'),
    );
    if (targetKeys.length > 0) {
      await redis.del(...targetKeys);
      console.log(`🧹 Flushed ${targetKeys.length} Redis cache keys.`);
    }
    await redis.quit();
  } catch (err) {
    console.warn('⚠️ Warning Redis flush:', err);
  }

  console.log(
    '\n🎉 ALL DONE! The name has been cleanly updated to "Tấn Thành" everywhere.',
  );
}

run()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
