import 'dotenv/config';
import {
  PrismaClient,
  Role,
  AttachmentType,
  WorkItemPriority,
  CycleStatus,
  PageStatus,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/rpm_db?schema=public',
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🌱 Starting database seeding...');

  // 1. Clean existing sample data
  console.log('🧹 Clearing previous seed data...');
  await prisma.sticky.deleteMany();
  await prisma.pageComment.deleteMany();
  await prisma.workItemComment.deleteMany();
  await prisma.workItem.deleteMany();
  await prisma.cycle.deleteMany();
  await prisma.pageVersion.deleteMany();
  await prisma.page.deleteMany();
  await prisma.collectionItem.deleteMany();
  await prisma.item.deleteMany();
  await prisma.collection.deleteMany();
  await prisma.label.deleteMany();
  await prisma.file.deleteMany();
  await prisma.projectMember.deleteMany();
  await prisma.projectState.deleteMany();
  await prisma.project.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.userProfile.deleteMany();
  await prisma.user.deleteMany();

  // 2. Create Users
  const passwordHash = await bcrypt.hash('Password123!', 10);
  const adminUser = await prisma.user.create({
    data: {
      email: 'admin@rpm.local',
      password: passwordHash,
      status: 'active',
      profile: {
        create: {
          name: 'Dr. Evelyn Vance',
          avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
        },
      },
    },
  });

  const researcherUser = await prisma.user.create({
    data: {
      email: 'researcher@rpm.local',
      password: passwordHash,
      status: 'active',
      profile: {
        create: {
          name: 'Alex Chen',
          avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
        },
      },
    },
  });

  console.log(`👤 Created users: ${adminUser.email}, ${researcherUser.email}`);

  // 3. Create Project (User -> Project model)
  const project = await prisma.project.create({
    data: {
      name: 'Physics-Informed Deep Learning for Navier-Stokes',
      identifier: 'PIDL',
      description: 'Accelerating computational fluid dynamics solvers using neural operator architectures and transformer attention.',
      createdById: adminUser.id,
      members: {
        create: [
          { userId: adminUser.id, role: Role.owner },
          { userId: researcherUser.id, role: Role.contributor },
        ],
      },
    },
  });

  // Seed default WorkItemState workflow states
  await prisma.workItemState.createMany({
    data: [
      { id: 'backlog', name: 'Backlog', color: '#6366F1', group: 'backlog', sequence: 1000, isDefault: false, projectId: project.id },
      { id: 'todo', name: 'To Do', color: '#0EA5E9', group: 'unstarted', sequence: 2000, isDefault: true, projectId: project.id },
      { id: 'in_progress', name: 'In Progress', color: '#F59E0B', group: 'started', sequence: 3000, isDefault: false, projectId: project.id },
      { id: 'review', name: 'Under Review', color: '#8B5CF6', group: 'started', sequence: 4000, isDefault: false, projectId: project.id },
      { id: 'done', name: 'Completed', color: '#10B981', group: 'completed', sequence: 5000, isDefault: false, projectId: project.id },
    ],
  });

  console.log(`📁 Created project: ${project.name} (${project.id}) with default workflow states`);

  // 4. Create Library Collections & Papers
  const collection = await prisma.collection.create({
    data: {
      name: 'Neural Operators & PDE Solvers',
      description: 'Foundational literature on Fourier Neural Operators (FNO) and DeepONets.',
      color: '#3b82f6',
      icon: 'Atom',
      userId: adminUser.id,
      projectId: project.id,
    },
  });

  const paper1 = await prisma.item.create({
    data: {
      title: 'Fourier Neural Operator for Parametric Partial Differential Equations',
      abstract: 'We propose a new framework for learning operators: Fourier Neural Operator (FNO). FNO maps infinite-dimensional function spaces with mesh-independent zero-shot super-resolution.',
      year: 2021,
      publicationTitle: 'International Conference on Learning Representations (ICLR)',
      doi: '10.48550/arXiv.2010.08895',
      citationKey: 'li2021fourier',
      userId: adminUser.id,
      uploadedById: adminUser.id,
      projectId: project.id,
      contributors: {
        create: [
          { creatorType: 'author', fullName: 'Zongyi Li', orderIndex: 0 },
          { creatorType: 'author', fullName: 'Nikola Kovachki', orderIndex: 1 },
          { creatorType: 'author', fullName: 'Kamyar Azizzadenesheli', orderIndex: 2 },
          { creatorType: 'author', fullName: 'Burigede Liu', orderIndex: 3 },
          { creatorType: 'author', fullName: 'Anima Anandkumar', orderIndex: 4 },
        ],
      },
      collectionItems: {
        create: [{ collectionId: collection.id }],
      },
    },
  });

  const paper2 = await prisma.item.create({
    data: {
      title: 'Physics-Informed Neural Networks: A Deep Learning Framework for Solving Forward and Inverse Problems',
      abstract: 'We introduce physics-informed neural networks -- neural networks that are trained to solve supervised learning tasks while respecting physical conservation laws described by general nonlinear PDEs.',
      year: 2019,
      publicationTitle: 'Journal of Computational Physics',
      doi: '10.1016/j.jcp.2018.10.045',
      citationKey: 'raissi2019physics',
      userId: researcherUser.id,
      uploadedById: researcherUser.id,
      projectId: project.id,
      contributors: {
        create: [
          { creatorType: 'author', fullName: 'M. Raissi', orderIndex: 0 },
          { creatorType: 'author', fullName: 'P. Perdikaris', orderIndex: 1 },
          { creatorType: 'author', fullName: 'G.E. Karniadakis', orderIndex: 2 },
        ],
      },
      collectionItems: {
        create: [{ collectionId: collection.id }],
      },
    },
  });

  console.log(`📚 Created papers: "${paper1.title}" and "${paper2.title}"`);

  // 5. Create Manuscript Pages (LaTeX hierarchy)
  const mainPage = await prisma.page.create({
    data: {
      title: 'main.tex',
      content: {
        type: 'latex',
        source: `\\documentclass{article}\n\\usepackage{amsmath,amssymb,graphicx}\n\\title{Neural Operator Benchmarks for High Reynolds Fluid Flow}\n\\author{Evelyn Vance, Alex Chen}\n\\begin{document}\n\\maketitle\n\\input{sections/abstract}\n\\input{sections/methodology}\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}`,
      },
      status: PageStatus.draft,
      projectId: project.id,
      authorId: adminUser.id,
    },
  });

  const abstractPage = await prisma.page.create({
    data: {
      title: 'abstract.tex',
      content: {
        type: 'latex',
        source: `\\section*{Abstract}\nIn this paper, we benchmark physics-informed transformer architectures against classical numerical solvers on 3D turbulent flow regimes.`,
      },
      status: PageStatus.draft,
      projectId: project.id,
      authorId: researcherUser.id,
      parentPageId: mainPage.id,
    },
  });

  console.log(`📝 Created LaTeX manuscript pages: ${mainPage.title}, ${abstractPage.title}`);

  // 6. Create Cycles / Sprints
  const cycle = await prisma.cycle.create({
    data: {
      name: 'Sprint 1: Architecture & Loss Formulation',
      description: 'Implement Sobolev loss penalty and setup baseline FNO vs U-Net benchmarks.',
      status: CycleStatus.active,
      startDate: new Date(),
      endDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      projectId: project.id,
      authorId: adminUser.id,
      milestones: [
        { title: 'Loss Function Formulation', completed: true },
        { title: 'Training pipeline validation', completed: false },
      ],
    },
  });

  // 7. Create Work Items
  await prisma.workItem.create({
    data: {
      title: 'Implement H1 Sobolev norm regularization',
      content: 'Add gradient penalty to enforce conservation of vorticity in Navier-Stokes 2D box test cases.',
      columnId: 'in_progress',
      priority: WorkItemPriority.high,
      completed: false,
      projectId: project.id,
      authorId: adminUser.id,
      assigneeId: researcherUser.id,
      cycleId: cycle.id,
    },
  });

  await prisma.workItem.create({
    data: {
      title: 'Export BibTeX citations for related works',
      content: 'Aggregate CSL bibliography entries into references.bib for LaTeX compiler sync.',
      columnId: 'todo',
      priority: WorkItemPriority.medium,
      completed: false,
      projectId: project.id,
      authorId: researcherUser.id,
      assigneeId: adminUser.id,
      cycleId: cycle.id,
    },
  });

  console.log(`📋 Created sprint cycle and work items.`);

  // 8. Create Personal Stickies
  await prisma.sticky.create({
    data: {
      title: 'Lab Meeting Notes',
      content: 'Remember to submit camera-ready preprint to arXiv by Friday 5 PM EST.',
      color: 'yellow-1',
      positionX: 40,
      positionY: 80,
      order: 0,
      userId: adminUser.id,
    },
  });

  await prisma.sticky.create({
    data: {
      title: 'Cluster GPU Allocation',
      content: 'Nodes A100-node[01-04] reserved for Reynolds number 10,000 simulations.',
      color: 'cyan-1',
      positionX: 320,
      positionY: 80,
      order: 1,
      userId: researcherUser.id,
    },
  });

  console.log(`📌 Created personal stickies.`);
  console.log('✅ Database seeding finished successfully!');
  console.log('--------------------------------------------------');
  console.log('🔑 Demo Login Credentials:');
  console.log('   Admin:      admin@rpm.local      / Password123!');
  console.log('   Researcher: researcher@rpm.local / Password123!');
  console.log('--------------------------------------------------');
}

main()
  .catch((e) => {
    console.error('❌ Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
