import 'dotenv/config';
import {
  PrismaClient,
  WorkspaceMemberRole,
  ProjectMemberRole,
  AttachmentType,
  TaskPriority,
  CycleStatus,
  CyclePhase,
  StickyScope,
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
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WorkspaceMemberRole') THEN
        CREATE TYPE "WorkspaceMemberRole" AS ENUM ('owner', 'admin', 'member', 'viewer');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProjectMemberRole') THEN
        CREATE TYPE "ProjectMemberRole" AS ENUM ('admin', 'contributor', 'commenter', 'viewer');
      END IF;
    END $$;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'workspace_members' AND column_name = 'role') THEN
        ALTER TABLE workspace_members ALTER COLUMN role DROP DEFAULT;
        ALTER TABLE workspace_members ALTER COLUMN role TYPE text;
        ALTER TABLE workspace_members ALTER COLUMN role TYPE "WorkspaceMemberRole" USING (role::"WorkspaceMemberRole");
        ALTER TABLE workspace_members ALTER COLUMN role SET DEFAULT 'member'::"WorkspaceMemberRole";
      END IF;
    END $$;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'project_members' AND column_name = 'role') THEN
        ALTER TABLE project_members ALTER COLUMN role DROP DEFAULT;
        ALTER TABLE project_members ALTER COLUMN role TYPE text;
        UPDATE project_members SET role = 'admin' WHERE role = 'owner';
        UPDATE project_members SET role = 'contributor' WHERE role = 'member';
        ALTER TABLE project_members ALTER COLUMN role TYPE "ProjectMemberRole" USING (role::"ProjectMemberRole");
        ALTER TABLE project_members ALTER COLUMN role SET DEFAULT 'viewer'::"ProjectMemberRole";
      END IF;
    END $$;
  `);
  // 1. Clean existing sample data
  console.log('🧹 Clearing previous seed data...');
  await prisma.sticky.deleteMany();
  await prisma.pageComment.deleteMany();
  await prisma.taskComment.deleteMany();
  await prisma.task.deleteMany();
  await prisma.cycle.deleteMany();
  await prisma.pageVersion.deleteMany();
  await prisma.page.deleteMany();
  await prisma.catalogAttachment.deleteMany();
  await prisma.catalogItem.deleteMany();
  await prisma.collection.deleteMany();
  await prisma.label.deleteMany();
  await prisma.file.deleteMany();
  await prisma.projectMember.deleteMany();
  await prisma.project.deleteMany();
  await prisma.workspaceMember.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
  // 2. Create Users
  const passwordHash = await bcrypt.hash('Password123!', 10);
  const adminUser = await prisma.user.create({
    data: {
      email: 'admin@rpm.local',
      password: passwordHash,
      name: 'Dr. Evelyn Vance',
      avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
      isVerified: true,
    },
  });
  const researcherUser = await prisma.user.create({
    data: {
      email: 'researcher@rpm.local',
      password: passwordHash,
      name: 'Alex Chen',
      avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
      isVerified: true,
    },
  });
  console.log(`👤 Created users: ${adminUser.email}, ${researcherUser.email}`);
  // 3. Create Workspaces
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Quantum Intelligence & AI Lab',
      url: 'quantum-ai-lab',
      createdById: adminUser.id,
      members: {
        create: [
          { userId: adminUser.id, role: WorkspaceMemberRole.owner },
          { userId: researcherUser.id, role: WorkspaceMemberRole.member },
        ],
      },
    },
  });
  console.log(`🏢 Created workspace: ${workspace.name} (${workspace.id})`);
  // 4. Create Project
  const defaultColumns = [
    { id: 'backlog', title: 'Backlog', accentColor: 'gray' },
    { id: 'todo', title: 'To Do', accentColor: 'blue' },
    { id: 'in_progress', title: 'In Progress', accentColor: 'amber' },
    { id: 'review', title: 'Under Review', accentColor: 'purple' },
    { id: 'done', title: 'Completed', accentColor: 'emerald' },
  ];
  const project = await prisma.project.create({
    data: {
      name: 'Physics-Informed Deep Learning for Navier-Stokes',
      description: 'Accelerating computational fluid dynamics solvers using neural operator architectures and transformer attention.',
      workspaceId: workspace.id,
      createdById: adminUser.id,
      taskColumns: defaultColumns,
      members: {
        create: [
          { userId: adminUser.id, role: ProjectMemberRole.admin },
          { userId: researcherUser.id, role: ProjectMemberRole.contributor },
        ],
      },
    },
  });
  console.log(`📁 Created project: ${project.name} (${project.id})`);
  // 5. Create Library Collections & Papers
  const collection = await prisma.collection.create({
    data: {
      name: 'Neural Operators & PDE Solvers',
      description: 'Foundational literature on Fourier Neural Operators (FNO) and DeepONets.',
      color: '#3b82f6',
      icon: 'Atom',
      workspaceId: workspace.id,
      createdById: adminUser.id,
    },
  });
  const paper1 = await prisma.catalogItem.create({
    data: {
      title: 'Fourier Neural Operator for Parametric Partial Differential Equations',
      abstract: 'We propose a new framework for learning operators: Fourier Neural Operator (FNO). FNO maps infinite-dimensional function spaces with mesh-independent zero-shot super-resolution.',
      authors: ['Zongyi Li', 'Nikola Kovachki', 'Kamyar Azizzadenesheli', 'Burigede Liu', 'Anima Anandkumar'],
      year: 2021,
      journal: 'International Conference on Learning Representations (ICLR)',
      doi: '10.48550/arXiv.2010.08895',
      citationKey: 'li2021fourier',
      filename: 'fno_2021.pdf',
      fileUrl: 'https://r2.rpm.local/papers/fno_2021.pdf',
      workspaceId: workspace.id,
      collectionId: collection.id,
      uploadedById: adminUser.id,
    },
  });
  const paper2 = await prisma.catalogItem.create({
    data: {
      title: 'Physics-Informed Neural Networks: A Deep Learning Framework for Solving Forward and Inverse Problems',
      abstract: 'We introduce physics-informed neural networks -- neural networks that are trained to solve supervised learning tasks while respecting physical conservation laws described by general nonlinear PDEs.',
      authors: ['M. Raissi', 'P. Perdikaris', 'G.E. Karniadakis'],
      year: 2019,
      journal: 'Journal of Computational Physics',
      doi: '10.1016/j.jcp.2018.10.045',
      citationKey: 'raissi2019physics',
      filename: 'pinn_2019.pdf',
      fileUrl: 'https://r2.rpm.local/papers/pinn_2019.pdf',
      workspaceId: workspace.id,
      collectionId: collection.id,
      uploadedById: researcherUser.id,
    },
  });
  console.log(`📚 Created papers: "${paper1.title}" and "${paper2.title}"`);
  // 6. Create Manuscript Pages (LaTeX hierarchy)
  const mainPage = await prisma.page.create({
    data: {
      title: 'main.tex',
      content: {
        type: 'latex',
        source: `\\documentclass{article}\n\\usepackage{amsmath,amssymb,graphicx}\n\\title{Neural Operator Benchmarks for High Reynolds Fluid Flow}\n\\author{Evelyn Vance, Alex Chen}\n\\begin{document}\n\\maketitle\n\\input{sections/abstract}\n\\input{sections/methodology}\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}`,
      },
      status: PageStatus.draft,
      workspaceId: workspace.id,
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
      workspaceId: workspace.id,
      projectId: project.id,
      authorId: researcherUser.id,
      parentPageId: mainPage.id,
    },
  });
  console.log(`📝 Created LaTeX manuscript pages: ${mainPage.title}, ${abstractPage.title}`);
  // 7. Create Cycles / Sprints
  const cycle = await prisma.cycle.create({
    data: {
      name: 'Sprint 1: Architecture & Loss Formulation',
      description: 'Implement Sobolev loss penalty and setup baseline FNO vs U-Net benchmarks.',
      status: CycleStatus.active,
      phase: CyclePhase.methodology,
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
  // 8. Create Tasks
  await prisma.task.create({
    data: {
      title: 'Implement H1 Sobolev norm regularization',
      description: 'Add gradient penalty to enforce conservation of vorticity in Navier-Stokes 2D box test cases.',
      columnId: 'in_progress',
      priority: TaskPriority.high,
      completed: false,
      projectId: project.id,
      authorId: adminUser.id,
      assigneeId: researcherUser.id,
      cycleId: cycle.id,
      checklists: [
        { id: 'chk-1', text: 'Derive finite difference gradient kernel', completed: true },
        { id: 'chk-2', text: 'Benchmark tensor contraction memory profile', completed: false },
      ],
    },
  });
  await prisma.task.create({
    data: {
      title: 'Export BibTeX citations for related works',
      description: 'Aggregate CSL bibliography entries into references.bib for LaTeX compiler sync.',
      columnId: 'todo',
      priority: TaskPriority.medium,
      completed: false,
      projectId: project.id,
      authorId: researcherUser.id,
      assigneeId: adminUser.id,
      cycleId: cycle.id,
    },
  });
  console.log(`📋 Created sprint cycle and tasks.`);
  // 9. Create Collaboration Stickies
  await prisma.sticky.create({
    data: {
      title: 'Lab Meeting Notes',
      content: 'Remember to submit camera-ready preprint to arXiv by Friday 5 PM EST.',
      color: 'yellow-1',
      scope: StickyScope.workspace,
      positionX: 40,
      positionY: 80,
      order: 0,
      workspaceId: workspace.id,
      userId: adminUser.id,
    },
  });
  await prisma.sticky.create({
    data: {
      title: 'Cluster GPU Allocation',
      content: 'Nodes A100-node[01-04] reserved for Reynolds number 10,000 simulations.',
      color: 'cyan-1',
      scope: StickyScope.workspace,
      positionX: 320,
      positionY: 80,
      order: 1,
      workspaceId: workspace.id,
      userId: researcherUser.id,
    },
  });
  console.log(`📌 Created collaboration stickies.`);
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
