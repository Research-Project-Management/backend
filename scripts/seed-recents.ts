import 'dotenv/config';
import { PrismaClient, EntityType } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import Redis from 'ioredis';

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  return url;
}

const pool = new Pool({ connectionString: requireDatabaseUrl() });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })
  : null;

export async function seedRecents() {
  console.log('⚡ Starting Recents (Activity Events) seeding for ngotanthanh92.26@gmail.com...');

  const userThanh = await prisma.user.findFirst({
    where: { email: 'ngotanthanh92.26@gmail.com' },
  });
  if (!userThanh) throw new Error('User ngotanthanh92.26@gmail.com not found');

  const project = await prisma.project.findFirst({ where: { name: 'flux' } });
  if (!project) throw new Error('Project flux not found');

  // Find work items in flux
  const workItems = await prisma.workItem.findMany({
    where: { projectId: project.id },
    select: { id: true, title: true },
  });
  const wiMap = new Map(workItems.map((w) => [w.title, w.id]));

  // Find manuscript docs in flux
  const docs = await prisma.manuscriptDoc.findMany({
    where: { projectId: project.id },
    select: { id: true, path: true },
  });
  const docMap = new Map(docs.map((d) => [d.path, d.id]));

  // Find papers in library (active only)
  const papers = await prisma.item.findMany({
    where: { deletedAt: null },
    select: { id: true, title: true },
  });
  const paperMap = new Map(papers.map((p) => [p.title, p.id]));

  // Find storage files
  const files = await prisma.file.findMany({
    where: { authorId: userThanh.id, isFolder: false },
    select: { id: true, filename: true },
  });
  const fileMap = new Map(files.map((f) => [f.filename, f.id]));

  // Clean previous activity events for userThanh
  await prisma.activityEvent.deleteMany({
    where: { actorId: userThanh.id },
  });

  const now = Date.now();

  const eventsToCreate: Array<{
    entityType: EntityType;
    entityId: string;
    verb: string;
    actorId: string;
    projectId: string | null;
    createdAt: Date;
  }> = [];

  const userId = userThanh.id;

  // Helper to safely push event if target exists
  function addEvent(entityType: EntityType, entityId: string | undefined, verb: string, hoursAgo: number, projId: string | null = project?.id || null) {
    if (!entityId) return;
    eventsToCreate.push({
      entityType,
      entityId,
      verb,
      actorId: userId,
      projectId: projId,
      createdAt: new Date(now - hoursAgo * 3600000),
    });
  }

  // 1. Work Items
  const wiAlg = wiMap.get('Write algorithm pseudo-code in LaTeX algorithm environment') || workItems[0]?.id;
  addEvent(EntityType.work_item, wiAlg, 'updated', 0.8); // 45m ago

  const wiAdam = wiMap.get('Investigate AdamW weight decay scaling on 70B parameter models') || workItems[1]?.id;
  addEvent(EntityType.work_item, wiAdam, 'commented', 3);

  const wiFp16 = wiMap.get('Evaluate FP16 mixed precision vs BF16 gradient stability on A100/H100') || workItems[2]?.id;
  addEvent(EntityType.work_item, wiFp16, 'status_changed', 8);

  const wiAdafactor = wiMap.get('Benchmark Adafactor vs Adam on 1D Burgers and Navier-Stokes PDE solvers') || workItems[3]?.id;
  addEvent(EntityType.work_item, wiAdafactor, 'updated', 24); // 1 day ago

  const wiSophia = wiMap.get('Survey second-order curvature approximations (Sophia vs K-FAC)') || workItems[4]?.id;
  addEvent(EntityType.work_item, wiSophia, 'assigned', 48); // 2 days ago

  // 2. Manuscript Pages (LaTeX docs)
  const docMain = docMap.get('/main.tex') || docs[0]?.id;
  addEvent(EntityType.page, docMain, 'edited', 1.5); // 1.5 hours ago

  const docBg = docMap.get('background.tex') || docs[1]?.id;
  addEvent(EntityType.page, docBg, 'edited', 5.5);

  const docViz = docMap.get('visualizations.tex') || docs[2]?.id;
  addEvent(EntityType.page, docViz, 'edited', 18);

  const docTrain = docMap.get('training.tex') || docs[3]?.id;
  addEvent(EntityType.page, docTrain, 'edited', 42); // 1.7 days ago

  // 3. Library Papers
  const pAttention = paperMap.get('Attention Is All You Need') || papers[0]?.id;
  addEvent(EntityType.paper, pAttention, 'viewed', 4, null);

  const pLlama = paperMap.get('Language Models are Few-Shot Learners') || papers[1]?.id;
  addEvent(EntityType.paper, pLlama, 'annotated', 14, null);

  const pDeepSeek = paperMap.get('DeepSeek-V2: A Strong, Economical, and Efficient Mixture-of-Experts Language Model') || papers[2]?.id;
  addEvent(EntityType.paper, pDeepSeek, 'viewed', 30, null);

  // 4. Storage Files
  const fProposal = fileMap.get('research_proposal_2026.pdf') || files[0]?.id;
  addEvent(EntityType.file, fProposal, 'uploaded_version', 6, null);

  const fDiagram = fileMap.get('model_architecture_diagram.png') || files[1]?.id;
  addEvent(EntityType.file, fDiagram, 'shared', 12, null);

  const fMatrix = fileMap.get('experiment_matrix_v3.xlsx') || files[2]?.id;
  addEvent(EntityType.file, fMatrix, 'updated', 26, null);

  // 5. Project Flux
  addEvent(EntityType.project, project.id, 'accessed', 52, project.id);

  // Sort descending by createdAt
  eventsToCreate.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  for (const evt of eventsToCreate) {
    await prisma.activityEvent.create({ data: evt });
  }

  console.log(`✅ Seeded ${eventsToCreate.length} realistic ActivityEvents for Recents!`);

  // Invalidate Redis cache for userRecent
  if (redis) {
    try {
      await redis.connect();
      const keys = await redis.keys('*recent*');
      const feedKeys = await redis.keys('*feed*');
      const allKeys = [...keys, ...feedKeys];
      if (allKeys.length > 0) {
        await redis.del(...allKeys);
        console.log(`🧹 Invalidated ${allKeys.length} Redis activity cache keys.`);
      }
      redis.disconnect();
    } catch (err) {
      console.warn('⚠️ Redis invalidation skipped:', (err as Error).message);
    }
  }
}

if (require.main === module) {
  seedRecents()
    .catch((e) => {
      console.error('❌ Seeding failed:', e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
      await pool.end();
    });
}
