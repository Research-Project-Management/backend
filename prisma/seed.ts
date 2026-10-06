import 'dotenv/config';
import { PrismaClient, Role, WorkItemPriority } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import Redis from 'ioredis';
import { SCHEMA_V42_DATA } from '../src/modules/library/shared-kernel/types/schema.constants';
import { seedLibrary } from './seed-library';

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://postgres:Thanh26102006@localhost:5433/flux-db?schema=public',
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log(
    '🌱 Starting comprehensive enterprise database seeding for project "flux"...',
  );

  // 1. Clean existing sample data in foreign-key safe order
  console.log('🧹 Clearing previous seed data (preserving user accounts)...');
  try {
    await prisma.sticky.deleteMany();
    await prisma.workItemComment.deleteMany();
    await prisma.workItemLabelAssignment.deleteMany();
    await prisma.workItemRelation.deleteMany();
    await prisma.workItemEntityLink.deleteMany();
    await prisma.workItemAssignee.deleteMany();
    await prisma.workItemDraft.deleteMany();
    await prisma.workItem.deleteMany();
    await prisma.workItemLabel.deleteMany();
    await prisma.workItemState.deleteMany();
    await prisma.manuscriptNode.deleteMany();
    await prisma.manuscriptDoc.deleteMany();
    await prisma.collectionItem.deleteMany();
    await prisma.item.deleteMany();
    await prisma.collection.deleteMany();
    await prisma.projectLabel.deleteMany();
    await prisma.label.deleteMany();
    await prisma.file.deleteMany();
    await prisma.projectMember.deleteMany();
    await prisma.projectState.deleteMany();
    await prisma.project.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.userProfile.deleteMany({
      where: { user: { email: { not: 'ngotanthanh92.26@gmail.com' } } },
    });
    await prisma.user.deleteMany({
      where: { email: { not: 'ngotanthanh92.26@gmail.com' } },
    });
  } catch (err) {
    console.warn(
      '⚠️ Warning during cleanup (tables might be empty):',
      (err as Error).message,
    );
  }

  // 2. Fetch or update primary Google user Thanh and create collaborators
  const passwordHash = await bcrypt.hash('Password123!', 10);
  let userThanh = await prisma.user.findFirst({
    where: { email: 'ngotanthanh92.26@gmail.com' },
    include: { profile: true, accounts: true },
  });

  if (!userThanh) {
    userThanh = await prisma.user.create({
      data: {
        email: 'ngotanthanh92.26@gmail.com',
        password: passwordHash,
        status: 'active',
        profile: {
          create: {
            name: 'GS. TS. Ngô Tấn Thành',
            avatar:
              'https://lh3.googleusercontent.com/a/ACg8ocLfL42lSWtqIwZdRz8r9d64G5dfKsAaMJ8SvRMLcWSckzM5KbY=s96-c',
          },
        },
      },
      include: { profile: true, accounts: true },
    });
  } else {
    userThanh = await prisma.user.update({
      where: { id: userThanh.id },
      data: {
        password: passwordHash,
        status: 'active',
      },
      include: { profile: true, accounts: true },
    });

    if (!userThanh.profile) {
      await prisma.userProfile.create({
        data: {
          userId: userThanh.id,
          name: 'GS. TS. Ngô Tấn Thành',
          avatar:
            'https://lh3.googleusercontent.com/a/ACg8ocLfL42lSWtqIwZdRz8r9d64G5dfKsAaMJ8SvRMLcWSckzM5KbY=s96-c',
        },
      });
    }
  }

  const adminUser = await prisma.user.create({
    data: {
      email: 'admin@rpm.local',
      password: passwordHash,
      status: 'active',
      profile: {
        create: {
          name: 'Dr. Evelyn Vance',
          avatar:
            'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
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
          avatar:
            'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
        },
      },
    },
  });

  const reviewerUser = await prisma.user.create({
    data: {
      email: 'reviewer@rpm.local',
      password: passwordHash,
      status: 'active',
      profile: {
        create: {
          name: 'Dr. Marcus Brody',
          avatar:
            'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150',
        },
      },
    },
  });

  console.log(
    `👤 Users configured: ${userThanh.email} (Owner), ${adminUser.email} (PI), ${researcherUser.email} (Fellow), ${reviewerUser.email} (Reviewer)`,
  );

  // 3. Create Project "flux" (identifier: FLUX)
  const project = await prisma.project.create({
    data: {
      name: 'flux',
      identifier: 'FLUX',
      description:
        'Large-scale collaborative research workspace: Adaptive Optimization, Foundation Models, and High-Performance Scientific Computing.',
      createdById: userThanh.id,
      workItemSequence: 43,
      members: {
        create: [
          { userId: userThanh.id, role: Role.owner },
          { userId: adminUser.id, role: Role.owner },
          { userId: researcherUser.id, role: Role.contributor },
          { userId: reviewerUser.id, role: Role.reviewer },
        ],
      },
    },
  });

  console.log(
    `📁 Created project: ${project.name} (${project.identifier}) owned by ${userThanh.email}`,
  );

  // 4. Seed default WorkItemState workflow states (5 default state groups)
  await prisma.workItemState.createMany({
    data: [
      {
        id: 'backlog',
        name: 'Backlog',
        color: '#6B7280',
        group: 'backlog',
        sequence: 1000,
        isDefault: true,
        projectId: project.id,
      },
      {
        id: 'todo',
        name: 'To Do',
        color: '#94A3B8',
        group: 'unstarted',
        sequence: 2000,
        isDefault: false,
        projectId: project.id,
      },
      {
        id: 'in_progress',
        name: 'In Progress',
        color: '#D97706',
        group: 'started',
        sequence: 3000,
        isDefault: false,
        projectId: project.id,
      },
      {
        id: 'done',
        name: 'Done',
        color: '#1A7F37',
        group: 'completed',
        sequence: 4000,
        isDefault: false,
        projectId: project.id,
      },
      {
        id: 'cancelled',
        name: 'Cancelled',
        color: '#9CA3AF',
        group: 'cancelled',
        sequence: 5000,
        isDefault: false,
        projectId: project.id,
      },
    ],
  });

  // 5. Seed WorkItemLabels (Academic & Technical taxonomy)
  const lblDL = await prisma.workItemLabel.create({
    data: {
      name: 'Deep Learning',
      color: '#3B82F6',
      description: 'Neural operator models and deep learning architectures',
      projectId: project.id,
      createdById: userThanh.id,
      sortOrder: 1,
    },
  });
  const lblOpt = await prisma.workItemLabel.create({
    data: {
      name: 'Optimization',
      color: '#06B6D4',
      description: 'Stochastic gradients, Adam, momentum, and learning rates',
      projectId: project.id,
      createdById: userThanh.id,
      sortOrder: 2,
    },
  });
  const lblLoss = await prisma.workItemLabel.create({
    data: {
      name: 'Loss Function',
      color: '#8B5CF6',
      description: 'Empirical risk, weight decay, and regularization',
      projectId: project.id,
      createdById: adminUser.id,
      sortOrder: 3,
    },
  });
  const lblLatex = await prisma.workItemLabel.create({
    data: {
      name: 'LaTeX Manuscript',
      color: '#10B981',
      description: 'Paper drafting, figures, and CLSI compilation',
      projectId: project.id,
      createdById: userThanh.id,
      sortOrder: 4,
    },
  });
  const lblGPU = await prisma.workItemLabel.create({
    data: {
      name: 'GPU Cluster & HPC',
      color: '#F59E0B',
      description: 'CUDA, DDP, multi-GPU scaling, and memory efficiency',
      projectId: project.id,
      createdById: adminUser.id,
      sortOrder: 5,
    },
  });
  const lblBib = await prisma.workItemLabel.create({
    data: {
      name: 'BibTeX & Literature',
      color: '#EC4899',
      description: 'Reference management and literature integration',
      projectId: project.id,
      createdById: researcherUser.id,
      sortOrder: 6,
    },
  });
  const lblReview = await prisma.workItemLabel.create({
    data: {
      name: 'Peer Review',
      color: '#F97316',
      description: 'Reviewer comments, rebuttals, and revisions',
      projectId: project.id,
      createdById: reviewerUser.id,
      sortOrder: 7,
    },
  });
  const lblBench = await prisma.workItemLabel.create({
    data: {
      name: 'Benchmark',
      color: '#6366F1',
      description: 'Performance comparison across MNIST, CIFAR, and ImageNet',
      projectId: project.id,
      createdById: userThanh.id,
      sortOrder: 8,
    },
  });

  console.log('🏷️ Created 8 work-item taxonomy labels.');

  // Helper helpers
  const assignLabel = async (workItemId: string, labelId: string) => {
    await prisma.workItemLabelAssignment.create({
      data: { workItemId, labelId },
    });
  };
  const assignUser = async (
    workItemId: string,
    userId: string,
    isPrimary = false,
  ) => {
    await prisma.workItemAssignee.create({
      data: { workItemId, userId, isPrimary },
    });
  };

  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;

  // 6. Create 42 Realistic Work Items (FLUX-1 to FLUX-42)
  console.log('📋 Seeding comprehensive 42 Work Items for project "flux"...');

  const workItemDefinitions: Array<{
    seq: number;
    col: string;
    prio: WorkItemPriority;
    title: string;
    content: string;
    author: string;
    assignee: string;
    labels: string[];
    completed?: boolean;
    parentSeq?: number;
    startDelta?: number;
    daysDelta?: number;
    timeSpent?: number;
  }> = [
    // ── BACKLOG (8): Future Research Milestones ──
    {
      seq: 1,
      col: 'backlog',
      prio: WorkItemPriority.medium,
      title: 'Investigate AdamW weight decay scaling on 70B parameter models',
      content:
        'Explore decoupled weight decay dynamics with cosine learning rate annealing on LLaMA-70B architecture.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblDL.id, lblOpt.id],
      daysDelta: 32,
      timeSpent: 0,
    },
    {
      seq: 2,
      col: 'backlog',
      prio: WorkItemPriority.low,
      title:
        'Benchmark Adafactor vs Adam on 1D Burgers and Navier-Stokes PDE solvers',
      content:
        'Measure memory footprint and relative L2 error over shock formation regimes.',
      author: researcherUser.id,
      assignee: researcherUser.id,
      labels: [lblDL.id, lblBench.id],
      daysDelta: 35,
      timeSpent: 0,
    },
    {
      seq: 3,
      col: 'backlog',
      prio: WorkItemPriority.none,
      title:
        'Evaluate FP16 mixed precision vs BF16 gradient stability on A100/H100',
      content:
        'Profile PyTorch AMP under second-order moment calculation to prevent underflow.',
      author: adminUser.id,
      assignee: userThanh.id,
      labels: [lblGPU.id],
      timeSpent: 0,
    },
    {
      seq: 4,
      col: 'backlog',
      prio: WorkItemPriority.medium,
      title: 'Survey second-order curvature approximations (Sophia vs K-FAC)',
      content:
        'Review recent diagonal Hessian estimates for pretraining transformers at sub-quadratic cost.',
      author: researcherUser.id,
      assignee: userThanh.id,
      labels: [lblOpt.id, lblBib.id],
      daysDelta: 39,
      timeSpent: 0,
    },
    {
      seq: 5,
      col: 'backlog',
      prio: WorkItemPriority.low,
      title:
        'Explore 8-bit quantized optimizer states with block-wise dynamic scaling',
      content:
        'Implement Dettmers et al. block-wise quantization for optimizer first and second moments.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblGPU.id, lblOpt.id],
      timeSpent: 0,
    },
    {
      seq: 6,
      col: 'backlog',
      prio: WorkItemPriority.medium,
      title:
        'Investigate learning rate warmup schedules for Transformer attention entropy',
      content:
        'Analyze early training instability and entropy collapse in self-attention layers.',
      author: adminUser.id,
      assignee: researcherUser.id,
      labels: [lblDL.id],
      daysDelta: 45,
      timeSpent: 0,
    },
    {
      seq: 7,
      col: 'backlog',
      prio: WorkItemPriority.low,
      title:
        'Evaluate Muon optimizer momentum orthogonalization on matrix weights',
      content:
        'Benchmark matrix-valued Newton-Schulz iterations on linear projection layers.',
      author: researcherUser.id,
      assignee: userThanh.id,
      labels: [lblOpt.id],
      timeSpent: 0,
    },
    {
      seq: 8,
      col: 'backlog',
      prio: WorkItemPriority.none,
      title: 'Draft grant proposal for NSF Supercomputing Resource Allocation',
      content:
        'Prepare technical narrative highlighting high-performance distributed optimizer research.',
      author: adminUser.id,
      assignee: userThanh.id,
      labels: [lblReview.id],
      daysDelta: 52,
      timeSpent: 0,
    },

    // ── TO DO (10): Upcoming Sprint Execution ──
    {
      seq: 9,
      col: 'todo',
      prio: WorkItemPriority.high,
      title: 'Derive second moment vector bias correction term in Theorem 1',
      content:
        'Formulate mathematical proof that initial estimates are biased towards zero.',
      author: adminUser.id,
      assignee: userThanh.id,
      labels: [lblOpt.id, lblLoss.id],
      daysDelta: 7,
      timeSpent: 0,
    },
    {
      seq: 10,
      col: 'todo',
      prio: WorkItemPriority.medium,
      title:
        'Export BibTeX citations from Zotero collection into references.bib',
      content:
        'Synchronize 32 literature references from Library collections into references.bib.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblBib.id, lblLatex.id],
      daysDelta: 4,
      timeSpent: 0,
    },
    {
      seq: 11,
      col: 'todo',
      prio: WorkItemPriority.high,
      title:
        'Configure multi-node Slurm job scripts for 64x H100 distributed DDP training',
      content:
        'Write sbatch submission template with NCCL environment flags for 8x H100 nodes.',
      author: researcherUser.id,
      assignee: researcherUser.id,
      labels: [lblGPU.id],
      daysDelta: 9,
      timeSpent: 0,
    },
    {
      seq: 12,
      col: 'todo',
      prio: WorkItemPriority.medium,
      title: 'Implement FlashAttention-2 integration in benchmark suite',
      content:
        'Replace standard scaled dot-product attention with FlashAttention-2 kernel.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblGPU.id, lblBench.id],
      daysDelta: 10,
      timeSpent: 0,
    },
    {
      seq: 13,
      col: 'todo',
      prio: WorkItemPriority.high,
      title: 'Draft Section 3 (Related Work) comparative analysis',
      content:
        'Structure classical first-order, coordinate-wise adaptive, and modern pretraining optimizers.',
      author: researcherUser.id,
      assignee: userThanh.id,
      labels: [lblLatex.id],
      daysDelta: 12,
      timeSpent: 0,
    },
    {
      seq: 14,
      col: 'todo',
      prio: WorkItemPriority.urgent,
      title: 'Add mathematical definitions to macros/math_commands.tex',
      content:
        'Define operators for expectations, inner products, tensor contractions, and L-infinity norms.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblLatex.id],
      daysDelta: 3,
      timeSpent: 0,
    },
    {
      seq: 15,
      col: 'todo',
      prio: WorkItemPriority.medium,
      title: 'Profile CUDA memory bandwidth during optimizer state update',
      content:
        'Use NVIDIA Nsight Compute to profile memory bandwidth saturation during Adam step.',
      author: researcherUser.id,
      assignee: researcherUser.id,
      labels: [lblGPU.id],
      daysDelta: 13,
      timeSpent: 0,
    },
    {
      seq: 16,
      col: 'todo',
      prio: WorkItemPriority.low,
      title: 'Format Table 3 (Memory Footprint) with booktabs rules',
      content:
        'Ensure consistent horizontal rule styling and unit annotations (bytes/param).',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblLatex.id],
      daysDelta: 11,
      timeSpent: 0,
    },
    {
      seq: 17,
      col: 'todo',
      prio: WorkItemPriority.medium,
      title: 'Verify AMSGrad maximum second moment update routine',
      content:
        'Ensure v_hat coordinate-wise maximum preserves monotonicity across 100,000 steps.',
      author: adminUser.id,
      assignee: userThanh.id,
      labels: [lblOpt.id],
      daysDelta: 12,
      timeSpent: 0,
    },
    {
      seq: 18,
      col: 'todo',
      prio: WorkItemPriority.high,
      title: 'Prepare Beamer slide deck for lab progress presentation',
      content:
        'Draft 10 presentation slides summarizing core algorithm and empirical speedup.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblLatex.id],
      daysDelta: 8,
      timeSpent: 0,
    },

    // ── IN PROGRESS (10) ──
    {
      seq: 19,
      col: 'in_progress',
      prio: WorkItemPriority.urgent,
      title:
        'Implement Adam optimizer algorithm and verify empirical convergence',
      content:
        'Implement vectorized moving average updates for first and second moments in PyTorch autograd.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblDL.id, lblOpt.id],
      startDelta: -6,
      daysDelta: 4,
      timeSpent: 34.0,
    },
    {
      seq: 20,
      col: 'in_progress',
      prio: WorkItemPriority.high,
      title: 'Formulate moving average updates for first and second moments',
      content:
        'Write autograd kernel supporting fused backward and optimizer step.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblOpt.id],
      parentSeq: 19,
      completed: true,
      daysDelta: -3,
      timeSpent: 12.0,
    },
    {
      seq: 21,
      col: 'in_progress',
      prio: WorkItemPriority.urgent,
      title: 'Implement vectorized Adam update kernel in PyTorch autograd',
      content:
        'Benchmarked against standard torch.optim.AdamW with exact numerical parity.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblOpt.id],
      parentSeq: 19,
      completed: true,
      daysDelta: 0,
      timeSpent: 16.0,
    },
    {
      seq: 22,
      col: 'in_progress',
      prio: WorkItemPriority.medium,
      title: 'Validate loss backpropagation on MNIST and CIFAR-10 ConvNet',
      content:
        'Execute 40,000 iterations to verify numerical stability and zero loss spikes.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblBench.id],
      parentSeq: 19,
      completed: false,
      daysDelta: 3,
      timeSpent: 6.0,
    },
    {
      seq: 23,
      col: 'in_progress',
      prio: WorkItemPriority.high,
      title: 'Draft Section 2 (Algorithm & Dynamics) in main.tex',
      content:
        'Draft mathematical formulation of Algorithm 1, write LaTeX pseudocode, and render vector figures.',
      author: researcherUser.id,
      assignee: userThanh.id,
      labels: [lblLatex.id],
      startDelta: -5,
      daysDelta: 5,
      timeSpent: 19.5,
    },
    {
      seq: 24,
      col: 'in_progress',
      prio: WorkItemPriority.medium,
      title: 'Write algorithm pseudo-code in LaTeX algorithm environment',
      content:
        'Draft alg1_adam_core.tex with input requirements and output contracts.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblLatex.id],
      parentSeq: 23,
      completed: true,
      daysDelta: -1,
      timeSpent: 8.5,
    },
    {
      seq: 25,
      col: 'in_progress',
      prio: WorkItemPriority.medium,
      title: 'Produce TikZ vector diagram for step size adaptation',
      content:
        'Create publication-ready vector figure illustrating coordinate-wise scaling.',
      author: researcherUser.id,
      assignee: researcherUser.id,
      labels: [lblLatex.id],
      parentSeq: 23,
      completed: false,
      daysDelta: 4,
      timeSpent: 5.0,
    },
    {
      seq: 26,
      col: 'in_progress',
      prio: WorkItemPriority.medium,
      title:
        'Ablation study on hyperparameter sensitivity (beta_1=0.9, beta_2=0.999)',
      content:
        'Quantify trade-off between first moment smoothing and second moment variance across 500 epochs.',
      author: researcherUser.id,
      assignee: researcherUser.id,
      labels: [lblDL.id, lblBench.id],
      daysDelta: 6,
      timeSpent: 14.0,
    },
    {
      seq: 27,
      col: 'in_progress',
      prio: WorkItemPriority.high,
      title: 'Scale ImageNet ViT-B/16 training to 300 epochs',
      content:
        'Run distributed training across 64 GPUs with RandAugment and Mixup data augmentation.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblGPU.id, lblBench.id],
      startDelta: -3,
      daysDelta: 3,
      timeSpent: 22.0,
    },
    {
      seq: 28,
      col: 'in_progress',
      prio: WorkItemPriority.medium,
      title: 'Write Appendix A (Full Mathematical Proofs)',
      content:
        'Complete step-by-step algebraic transitions for Lemma 1, Lemma 2, and Theorem 1.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblLatex.id],
      daysDelta: 5,
      timeSpent: 11.5,
    },

    // ── IN PROGRESS / REVIEWS (6) ──
    {
      seq: 29,
      col: 'in_progress',
      prio: WorkItemPriority.high,
      title:
        'Validate regret bound proofs on online convex programming setting',
      content:
        'Review Theorem 1 in Section 6. Ensure regret bound R(T) = O(sqrt(T)) holds under decaying step sizes.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblDL.id, lblBench.id],
      daysDelta: 1,
      timeSpent: 15.0,
    },
    {
      seq: 30,
      col: 'in_progress',
      prio: WorkItemPriority.medium,
      title: 'Peer review Section 6: Convergence Analysis & Regret Bounds',
      content:
        'Review mathematical rigor and check whether claims on regret bounds are substantiated.',
      author: adminUser.id,
      assignee: reviewerUser.id,
      labels: [lblReview.id, lblLatex.id],
      daysDelta: 4,
      timeSpent: 6.5,
    },
    {
      seq: 31,
      col: 'in_progress',
      prio: WorkItemPriority.high,
      title:
        'Audit decoupled weight decay implementation against Loshchilov & Hutter',
      content:
        'Verify that weight decay multiplier eta_t matches learning rate schedule.',
      author: userThanh.id,
      assignee: reviewerUser.id,
      labels: [lblOpt.id, lblReview.id],
      startDelta: -2,
      daysDelta: 4,
      timeSpent: 4.5,
    },
    {
      seq: 32,
      col: 'in_progress',
      prio: WorkItemPriority.medium,
      title: 'Cross-check BibTeX citation keys across all 10 section files',
      content:
        'Verify zero undefined citation warnings during LaTeX compilation pass.',
      author: researcherUser.id,
      assignee: userThanh.id,
      labels: [lblBib.id, lblLatex.id],
      daysDelta: 2,
      timeSpent: 3.0,
    },
    {
      seq: 33,
      col: 'in_progress',
      prio: WorkItemPriority.low,
      title: 'Review Appendix B (Model Architecture Specifications)',
      content:
        'Confirm hidden dimensions, head counts, and parameter counts match official papers.',
      author: researcherUser.id,
      assignee: reviewerUser.id,
      labels: [lblReview.id],
      daysDelta: 5,
      timeSpent: 4.0,
    },
    {
      seq: 34,
      col: 'in_progress',
      prio: WorkItemPriority.high,
      title: 'Camera-ready compliance check for IEEE Transactions format',
      content:
        'Verify margin compliance, font embedding, and double-column twocolumn layout.',
      author: adminUser.id,
      assignee: userThanh.id,
      labels: [lblLatex.id, lblReview.id],
      daysDelta: 4,
      timeSpent: 2.5,
    },

    // ── COMPLETED (7) ──
    {
      seq: 35,
      col: 'done',
      prio: WorkItemPriority.high,
      title: 'Synthesize empirical results across Logistic Regression and MLPs',
      content:
        'Generated training and test loss curves across MNIST, IMDB sentiment, and CIFAR-10 datasets.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblOpt.id, lblBench.id],
      completed: true,
      daysDelta: -2,
      timeSpent: 28.0,
    },
    {
      seq: 36,
      col: 'done',
      prio: WorkItemPriority.urgent,
      title: 'Verify analytical upper bound on step size ratio in Theorem 1',
      content:
        'Analytically proved that the effective step size is upper bounded by gamma_t <= alpha * sqrt(1 - beta_2^t) / (1 - beta_1^t).',
      author: adminUser.id,
      assignee: userThanh.id,
      labels: [lblOpt.id, lblLoss.id],
      completed: true,
      daysDelta: -5,
      timeSpent: 21.0,
    },
    {
      seq: 37,
      col: 'done',
      prio: WorkItemPriority.medium,
      title:
        'Set up Overleaf/CLSI compiler integration and PDF generation engine',
      content:
        'Automated LaTeX compilation on main branch commits with pdftex and bibtex artifact export.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblLatex.id],
      completed: true,
      daysDelta: -10,
      timeSpent: 26.0,
    },
    {
      seq: 38,
      col: 'done',
      prio: WorkItemPriority.high,
      title: 'Construct 8x H100 cluster benchmark harness in PyTorch',
      content:
        'Configured automated throughput benchmarking script with synthetic and real data loaders.',
      author: researcherUser.id,
      assignee: researcherUser.id,
      labels: [lblGPU.id],
      completed: true,
      daysDelta: -7,
      timeSpent: 32.5,
    },
    {
      seq: 39,
      col: 'done',
      prio: WorkItemPriority.medium,
      title: 'Draft Section 1 (Introduction & Motivation)',
      content:
        'Authored comprehensive introduction detailing challenges in non-convex stochastic optimization.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblLatex.id],
      completed: true,
      daysDelta: -16,
      timeSpent: 18.5,
    },
    {
      seq: 40,
      col: 'done',
      prio: WorkItemPriority.medium,
      title: 'Set up Zotero schema v42 synchronization pipeline',
      content:
        'Configured base field mappings for 72 citation fields across book, article, and preprint types.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblBib.id],
      completed: true,
      daysDelta: -15,
      timeSpent: 14.0,
    },
    {
      seq: 41,
      col: 'done',
      prio: WorkItemPriority.low,
      title: 'Compile references.bib with 45 peer-reviewed ML papers',
      content:
        'Assembled landmark citations from Kingma, Vaswani, He, Loshchilov, Reddi, and Devlin.',
      author: userThanh.id,
      assignee: userThanh.id,
      labels: [lblBib.id],
      completed: true,
      daysDelta: -12,
      timeSpent: 11.0,
    },

    // ── CANCELLED (1) ──
    {
      seq: 42,
      col: 'cancelled',
      prio: WorkItemPriority.low,
      title:
        'Evaluate vanilla SGD without momentum baseline on non-convex objectives',
      content:
        'Vanilla SGD completely stalls in saddle points and ravines on complex deep neural network landscapes. Deprecated in favor of AdaGrad and Adam baselines.',
      author: researcherUser.id,
      assignee: researcherUser.id,
      labels: [lblDL.id],
      completed: false,
      daysDelta: -18,
      timeSpent: 6.0,
    },
  ];

  const createdWorkItemsMap = new Map<number, string>();

  for (const def of workItemDefinitions) {
    const parentId = def.parentSeq
      ? createdWorkItemsMap.get(def.parentSeq)
      : undefined;
    const startDate =
      def.startDelta !== undefined
        ? new Date(now.getTime() + def.startDelta * dayMs)
        : undefined;
    const dueDate =
      def.daysDelta !== undefined
        ? new Date(now.getTime() + def.daysDelta * dayMs)
        : undefined;

    const wi = await prisma.workItem.create({
      data: {
        sequenceNumber: def.seq,
        identifier: `FLUX-${def.seq}`,
        title: def.title,
        content: def.content,
        columnId: def.col,
        priority: def.prio,
        rank: def.seq * 100,
        labels: def.labels,
        authorId: def.author,
        assigneeId: def.assignee,
        assigneeIds: [def.assignee],
        parentWorkItemId: parentId,
        projectId: project.id,
        completed: def.completed ?? def.col === 'done',
        startDate,
        dueDate,
        timeSpent: def.timeSpent ?? 0,
      },
    });

    createdWorkItemsMap.set(def.seq, wi.id);

    for (const lbl of def.labels) {
      await assignLabel(wi.id, lbl);
    }
    await assignUser(wi.id, def.assignee, true);
  }

  // Seed logical work-item relations
  const seededRelations = [
    { sourceSeq: 20, targetSeq: 21, type: 'blocks' },
    { sourceSeq: 21, targetSeq: 22, type: 'blocks' },
    { sourceSeq: 24, targetSeq: 23, type: 'blocks' },
    { sourceSeq: 9, targetSeq: 36, type: 'relates_to' },
    { sourceSeq: 10, targetSeq: 41, type: 'relates_to' },
    { sourceSeq: 11, targetSeq: 27, type: 'relates_to' },
    { sourceSeq: 17, targetSeq: 31, type: 'relates_to' },
    { sourceSeq: 29, targetSeq: 30, type: 'relates_to' },
    { sourceSeq: 36, targetSeq: 28, type: 'relates_to' },
    { sourceSeq: 12, targetSeq: 26, type: 'relates_to' },
    { sourceSeq: 37, targetSeq: 34, type: 'relates_to' },
    { sourceSeq: 14, targetSeq: 23, type: 'relates_to' },
  ];

  for (const rel of seededRelations) {
    const sourceId = createdWorkItemsMap.get(rel.sourceSeq);
    const targetId = createdWorkItemsMap.get(rel.targetSeq);
    if (sourceId && targetId) {
      await prisma.workItemRelation
        .create({
          data: {
            sourceId,
            targetId,
            type: rel.type as any,
          },
        })
        .catch(() => null);
    }
  }

  // Add rich discussions on key tasks
  await prisma.workItemComment.create({
    data: {
      workItemId: createdWorkItemsMap.get(19)!,
      authorId: adminUser.id,
      content:
        'The bias-corrected second moment estimate prevents the optimizer from stalling in the early epochs when gradients are sparse.',
    },
  });
  await prisma.workItemComment.create({
    data: {
      workItemId: createdWorkItemsMap.get(19)!,
      authorId: userThanh.id,
      content:
        'Verified convergence curves on CIFAR-10 and ImageNet. Adam converges ~2.8x faster than standard SGD with momentum while maintaining optimal numerical stability.',
    },
  });
  await prisma.workItemComment.create({
    data: {
      workItemId: createdWorkItemsMap.get(29)!,
      authorId: reviewerUser.id,
      content:
        'The mathematical step from Lemma 2 to Theorem 1 is rigorous. Lemma 3 bounding the sum of alpha_t / sqrt(t) has been verified against Euler-Maclaurin summation.',
    },
  });

  console.log(
    `✅ Successfully seeded 42 Work Items (${createdWorkItemsMap.size} created).`,
  );

  // 7. Seed 32 Academic Papers Across 4 Major Collections (All Owned by userThanh)
  console.log(
    '📚 Seeding comprehensive 32 Library papers across 4 collections...',
  );

  // Collection 1: Foundation Models & LLM Architectures
  const col1 = await prisma.collection.create({
    data: {
      name: 'Foundation Models & LLM Architectures',
      description:
        'Landmark breakthroughs in Transformers, Attention, Pretraining, and Mixture-of-Experts.',
      color: '#3B82F6',
      icon: 'Cpu',
      userId: userThanh.id,
      projectId: project.id,
    },
  });

  // Collection 2: Optimization & Gradient Dynamics
  const col2 = await prisma.collection.create({
    data: {
      name: 'Optimization & Gradient Dynamics',
      description:
        'First and second-order adaptive algorithms: Adam, AdamW, AMSGrad, Lion, Sophia, Adafactor.',
      color: '#06B6D4',
      icon: 'TrendingUp',
      userId: userThanh.id,
      projectId: project.id,
    },
  });

  // Collection 3: Vision & Multimodal Intelligence
  const col3 = await prisma.collection.create({
    data: {
      name: 'Vision & Multimodal Intelligence',
      description:
        'Deep Residual networks, Vision Transformers (ViT), Diffusion Models, and Multimodal CLIP.',
      color: '#8B5CF6',
      icon: 'Eye',
      userId: userThanh.id,
      projectId: project.id,
    },
  });

  // Collection 4: Scientific Machine Learning & Neural Operators
  const col4 = await prisma.collection.create({
    data: {
      name: 'Scientific ML & Neural Operators',
      description:
        'Fourier Neural Operators, Physics-Informed Neural Networks, DeepONets, and Neural ODEs.',
      color: '#10B981',
      icon: 'Atom',
      userId: userThanh.id,
      projectId: project.id,
    },
  });

  const papersData: Array<{
    colId: string;
    title: string;
    abstract: string;
    year: number;
    pub: string;
    doi: string;
    key: string;
    authors: string[];
  }> = [
    // --- Collection 1: LLMs ---
    {
      colId: col1.id,
      title: 'Attention Is All You Need',
      abstract:
        'We propose the Transformer, an architecture based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.',
      year: 2017,
      pub: 'Advances in Neural Information Processing Systems (NeurIPS)',
      doi: '10.48550/arXiv.1706.03762',
      key: 'vaswani2017attention',
      authors: [
        'Ashish Vaswani',
        'Noam Shazeer',
        'Niki Parmar',
        'Jakob Uszkoreit',
        'Llion Jones',
        'Aidan N. Gomez',
        'Łukasz Kaiser',
        'Illia Polosukhin',
      ],
    },
    {
      colId: col1.id,
      title: 'Language Models are Few-Shot Learners',
      abstract:
        'We demonstrate that scaling up language models to 175 billion parameters greatly improves task-agnostic, few-shot performance on diverse NLP benchmarks.',
      year: 2020,
      pub: 'Advances in Neural Information Processing Systems (NeurIPS)',
      doi: '10.48550/arXiv.2005.14165',
      key: 'brown2020language',
      authors: [
        'Tom Brown',
        'Benjamin Mann',
        'Nick Ryder',
        'Melanie Subbiah',
        'Jared Kaplan',
        'Prafulla Dhariwal',
        'Arvind Neelakantan',
        'Dario Amodei',
      ],
    },
    {
      colId: col1.id,
      title: 'LLaMA: Open and Efficient Foundation Language Models',
      abstract:
        'We introduce LLaMA, a collection of foundation language models ranging from 7B to 65B parameters trained on trillions of tokens using standard AdamW.',
      year: 2023,
      pub: 'arXiv:2302.13971',
      doi: '10.48550/arXiv.2302.13971',
      key: 'touvron2023llama',
      authors: [
        'Hugo Touvron',
        'Thibaut Lavril',
        'Gautier Izacard',
        'Xavier Martinet',
        'Marie-Anne Lachaux',
        'Timothée Lacroix',
        'Guillaume Lample',
      ],
    },
    {
      colId: col1.id,
      title:
        'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
      abstract:
        'BERT is designed to pre-train deep bidirectional representations from unlabeled text by jointly conditioning on both left and right context in all layers.',
      year: 2019,
      pub: 'North American Chapter of the Association for Computational Linguistics (NAACL)',
      doi: '10.48550/arXiv.1810.04805',
      key: 'devlin2018bert',
      authors: [
        'Jacob Devlin',
        'Ming-Wei Chang',
        'Kenton Lee',
        'Kristina Toutanova',
      ],
    },
    {
      colId: col1.id,
      title: 'RoBERTa: A Robustly Optimized BERT Pretraining Approach',
      abstract:
        'We find that BERT was significantly undertrained, and propose RoBERTa which trains the model longer, with bigger batches, over more data, and without the next sentence prediction objective.',
      year: 2019,
      pub: 'arXiv:1907.11692',
      doi: '10.48550/arXiv.1907.11692',
      key: 'liu2019roberta',
      authors: [
        'Yinhan Liu',
        'Myle Ott',
        'Naman Goyal',
        'Jingfei Du',
        'Mandar Joshi',
        'Danqi Chen',
        'Mike Lewis',
        'Luke Zettlemoyer',
        'Veselin Stoyanov',
      ],
    },
    {
      colId: col1.id,
      title: 'Training Compute-Optimal Large Language Models',
      abstract:
        'We find that current large language models are significantly undertrained. Given a fixed compute budget, model size and number of tokens should be scaled in equal proportions.',
      year: 2022,
      pub: 'Advances in Neural Information Processing Systems (NeurIPS)',
      doi: '10.48550/arXiv.2203.15556',
      key: 'hoffmann2022training',
      authors: [
        'Jordan Hoffmann',
        'Sebastian Borgeaud',
        'Arthur Mensch',
        'Elena Buchatskaya',
        'Trevor Cai',
        'Eliza Rutherford',
        'Diego de Las Casas',
        'Oriol Vinyals',
      ],
    },
    {
      colId: col1.id,
      title: 'Mistral 7B',
      abstract:
        'We introduce Mistral 7B, a 7-billion-parameter language model using grouped-query attention and sliding window attention that outperforms all open models up to 13B.',
      year: 2023,
      pub: 'arXiv:2310.06825',
      doi: '10.48550/arXiv.2310.06825',
      key: 'jiang2023mistral',
      authors: [
        'Albert Q. Jiang',
        'Alexandre Sablayrolles',
        'Arthur Mensch',
        'Chris Bamford',
        'Devendra Singh Chaplot',
        'Guillaume Lample',
      ],
    },
    {
      colId: col1.id,
      title:
        'DeepSeek-V2: A Strong, Economical, and Efficient Mixture-of-Experts Language Model',
      abstract:
        'DeepSeek-V2 features Multi-head Latent Attention (MLA) and DeepSeekMoE architecture for ultra-efficient training and inference.',
      year: 2024,
      pub: 'arXiv:2405.04434',
      doi: '10.48550/arXiv.2405.04434',
      key: 'deepseek2024deepseek',
      authors: [
        'DeepSeek-AI',
        'Aixin Liu',
        'Bei Feng',
        'Bin Wang',
        'Bingxuan Wang',
        'Bo Liu',
      ],
    },
    {
      colId: col1.id,
      title: 'Gemini: A Family of Highly Capable Multimodal Models',
      abstract:
        'We introduce Gemini, a family of highly capable multimodal models trained natively on text, image, audio, and video modalities.',
      year: 2023,
      pub: 'arXiv:2312.11805',
      doi: '10.48550/arXiv.2312.11805',
      key: 'gemini2023family',
      authors: [
        'Gemini Team',
        'Google DeepMind',
        'Demis Hassabis',
        'Jeff Dean',
        'Koray Kavukcuoglu',
      ],
    },

    // --- Collection 2: Optimization ---
    {
      colId: col2.id,
      title: 'Adam: A Method for Stochastic Optimization',
      abstract:
        'We introduce Adam, an algorithm for first-order gradient-based optimization of stochastic objective functions, based on adaptive estimates of lower-order moments.',
      year: 2014,
      pub: 'International Conference on Learning Representations (ICLR 2015)',
      doi: '10.48550/arXiv.1412.6980',
      key: 'kingma2014adam',
      authors: ['Diederik P. Kingma', 'Jimmy Ba'],
    },
    {
      colId: col2.id,
      title: 'Decoupled Weight Decay Regularization (AdamW)',
      abstract:
        'L2 regularization and weight decay can be different when using adaptive gradients. We show that decoupled weight decay substantially improves generalization.',
      year: 2019,
      pub: 'International Conference on Learning Representations (ICLR 2019)',
      doi: '10.48550/arXiv.1711.05101',
      key: 'loshchilov2017decoupled',
      authors: ['Ilya Loshchilov', 'Frank Hutter'],
    },
    {
      colId: col2.id,
      title: 'On the Convergence of Adam and Beyond (AMSGrad)',
      abstract:
        'Several recently proposed stochastic optimization methods have been successfully used in training deep networks. We pinpoint a fundamental flaw in the convergence proof of Adam and propose AMSGrad.',
      year: 2018,
      pub: 'International Conference on Learning Representations (ICLR 2018)',
      doi: '10.48550/arXiv.1904.09237',
      key: 'reddi2018convergence',
      authors: ['Sashank J. Reddi', 'Satyen Kale', 'Sanjiv Kumar'],
    },
    {
      colId: col2.id,
      title: 'Symbolic Discovery of Optimization Algorithms (Lion)',
      abstract:
        'We use symbolic program search to discover Lion (EvoLved Sign Momentum), an algorithm requiring only the sign of the momentum, cutting optimizer state memory in half.',
      year: 2023,
      pub: 'Advances in Neural Information Processing Systems (NeurIPS)',
      doi: '10.48550/arXiv.2302.06675',
      key: 'chen2023symbolic',
      authors: [
        'Xiangning Chen',
        'Chen Liang',
        'Da Huang',
        'Esteban Real',
        'Quoc V. Le',
      ],
    },
    {
      colId: col2.id,
      title:
        'Sophia: A Second-order Stochastic Optimizer for Language Model Pre-training',
      abstract:
        'Sophia estimates the diagonal Hessian using lightweight Hutchinson-style matrix-vector products to achieve 2x faster wall-clock pretraining on LLMs.',
      year: 2023,
      pub: 'arXiv:2305.14342',
      doi: '10.48550/arXiv.2305.14342',
      key: 'liu2023sophia',
      authors: [
        'Hong Liu',
        'Zhiyuan Li',
        'David Hall',
        'Percy Liang',
        'Tengyu Ma',
      ],
    },
    {
      colId: col2.id,
      title: 'Adafactor: Adaptive Learning Rates with Sublinear Memory Cost',
      abstract:
        'We propose Adafactor, an adaptive curriculum learning rate method that maintains non-negative matrix factorizations of the second moments.',
      year: 2018,
      pub: 'International Conference on Machine Learning (ICML)',
      doi: '10.48550/arXiv.1804.04235',
      key: 'shazeer2018adafactor',
      authors: ['Noam Shazeer', 'Mitchell Stern'],
    },
    {
      colId: col2.id,
      title: 'Accurate, Large Minibatch SGD: Training ImageNet in 1 Hour',
      abstract:
        'We show that linear learning rate scaling with warmup enables training ResNet-50 on ImageNet with minibatch size 8192 in 1 hour without accuracy loss.',
      year: 2017,
      pub: 'arXiv:1706.02677',
      doi: '10.48550/arXiv.1706.02677',
      key: 'goyal2017accurate',
      authors: [
        'Priya Goyal',
        'Piotr Dollár',
        'Ross Girshick',
        'Pieter Noordhuis',
        'Lukasz Wesolowski',
        'Aapo Kyrola',
        'Kaiming He',
      ],
    },
    {
      colId: col2.id,
      title: 'Why Are Adaptive Methods Good for Attention Models?',
      abstract:
        'We show that the heavy-tailed distribution of gradients in attention models is the fundamental reason why adaptive coordinate-wise methods outperform SGD.',
      year: 2020,
      pub: 'Advances in Neural Information Processing Systems (NeurIPS)',
      doi: '10.48550/arXiv.1912.03194',
      key: 'zhang2020why',
      authors: [
        'Jingzhao Zhang',
        'Sai Praneeth Karimireddy',
        'Andreas Veit',
        'Seungyeon Kim',
        'Sashank Reddi',
        'Sanjiv Kumar',
        'Suvrit Sra',
      ],
    },

    // --- Collection 3: Vision & Multimodal ---
    {
      colId: col3.id,
      title: 'Deep Residual Learning for Image Recognition',
      abstract:
        'Deeper neural networks are more difficult to train. We present a residual learning framework to ease the training of networks that are substantially deeper than those used previously.',
      year: 2016,
      pub: 'IEEE Conference on Computer Vision and Pattern Recognition (CVPR 2016)',
      doi: '10.1109/CVPR.2016.90',
      key: 'he2016deep',
      authors: ['Kaiming He', 'Xiangyu Zhang', 'Shaoqing Ren', 'Jian Sun'],
    },
    {
      colId: col3.id,
      title:
        'An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale (ViT)',
      abstract:
        'We show that relying directly on sequences of image patches with standard Transformer encoders achieves state-of-the-art results on ImageNet when pretrained on large datasets.',
      year: 2021,
      pub: 'International Conference on Learning Representations (ICLR 2021)',
      doi: '10.48550/arXiv.2010.11929',
      key: 'dosovitskiy2020image',
      authors: [
        'Alexey Dosovitskiy',
        'Lucas Beyer',
        'Alexander Kolesnikov',
        'Dirk Weissenborn',
        'Xiaohua Zhai',
        'Thomas Unterthiner',
        'Mostafa Dehghani',
        'Neil Houlsby',
      ],
    },
    {
      colId: col3.id,
      title: 'Denoising Diffusion Probabilistic Models (DDPM)',
      abstract:
        'We present high quality image synthesis results using diffusion probabilistic models, a class of latent variable models inspired by non-equilibrium thermodynamics.',
      year: 2020,
      pub: 'Advances in Neural Information Processing Systems (NeurIPS)',
      doi: '10.48550/arXiv.2006.11239',
      key: 'ho2020denoising',
      authors: ['Jonathan Ho', 'Ajay Jain', 'Pieter Abbeel'],
    },
    {
      colId: col3.id,
      title:
        'High-Resolution Image Synthesis with Latent Diffusion Models (Stable Diffusion)',
      abstract:
        'By applying diffusion models in the latent space of powerful pretrained autoencoders, we turn diffusion models into efficient and flexible image generators.',
      year: 2022,
      pub: 'IEEE Conference on Computer Vision and Pattern Recognition (CVPR 2022)',
      doi: '10.1109/CVPR52688.2022.01042',
      key: 'rombach2022high',
      authors: [
        'Robin Rombach',
        'Andreas Blattmann',
        'Dominik Lorenz',
        'Patrick Esser',
        'Björn Ommer',
      ],
    },
    {
      colId: col3.id,
      title:
        'Learning Transferable Visual Models From Natural Language Supervision (CLIP)',
      abstract:
        'State-of-the-art computer vision systems are trained to predict a fixed set of categories. We demonstrate that predicting raw text descriptions enables zero-shot transfer.',
      year: 2021,
      pub: 'International Conference on Machine Learning (ICML)',
      doi: '10.48550/arXiv.2103.00020',
      key: 'radford2021learning',
      authors: [
        'Alec Radford',
        'Jong Wook Kim',
        'Chris Hallacy',
        'Aditya Ramesh',
        'Gabriel Goh',
        'Sandhini Agarwal',
        'Ilya Sutskever',
      ],
    },
    {
      colId: col3.id,
      title: 'Segment Anything (SAM)',
      abstract:
        'We introduce the Segment Anything (SAM) model and dataset (SA-1B), establishing promptable segmentation foundation models for computer vision.',
      year: 2023,
      pub: 'IEEE International Conference on Computer Vision (ICCV)',
      doi: '10.48550/arXiv.2304.02643',
      key: 'kirillov2023segment',
      authors: [
        'Alexander Kirillov',
        'Eric Mintun',
        'Nikhila Ravi',
        'Hanzi Mao',
        'Chloe Rolland',
        'Ross Girshick',
      ],
    },
    {
      colId: col3.id,
      title: 'Masked Autoencoders Are Scalable Vision Learners (MAE)',
      abstract:
        'Masked Autoencoders (MAE) is a simple autoencoding approach that reconstructs original signals given partial observation, masking 75% of input patches.',
      year: 2022,
      pub: 'IEEE Conference on Computer Vision and Pattern Recognition (CVPR 2022)',
      doi: '10.1109/CVPR52688.2022.01553',
      key: 'he2022masked',
      authors: [
        'Kaiming He',
        'Xinlei Chen',
        'Saining Xie',
        'Yanghao Li',
        'Piotr Dollár',
        'Ross Girshick',
      ],
    },
    {
      colId: col3.id,
      title:
        'NeRF: Representing Scenes as Neural Radiance Fields for View Synthesis',
      abstract:
        'We present a method that achieves state-of-the-art results for synthesizing novel views of complex scenes by optimizing an underlying continuous 5D neural radiance field.',
      year: 2020,
      pub: 'European Conference on Computer Vision (ECCV 2020)',
      doi: '10.48550/arXiv.2003.08934',
      key: 'mildenhall2020nerf',
      authors: [
        'Ben Mildenhall',
        'Pratul P. Srinivasan',
        'Matthew Tancik',
        'Jonathan T. Barron',
        'Ravi Ramamoorthi',
        'Ren Ng',
      ],
    },

    // --- Collection 4: Scientific ML ---
    {
      colId: col4.id,
      title:
        'Fourier Neural Operator for Parametric Partial Differential Equations (FNO)',
      abstract:
        'We propose a new framework for learning operators: Fourier Neural Operator (FNO). FNO maps infinite-dimensional function spaces with mesh-independent zero-shot super-resolution.',
      year: 2021,
      pub: 'International Conference on Learning Representations (ICLR 2021)',
      doi: '10.48550/arXiv.2010.08895',
      key: 'li2021fourier',
      authors: [
        'Zongyi Li',
        'Nikola Kovachki',
        'Kamyar Azizzadenesheli',
        'Burigede Liu',
        'Kaushik Bhattacharya',
        'Andrew Stuart',
        'Anima Anandkumar',
      ],
    },
    {
      colId: col4.id,
      title:
        'Physics-Informed Neural Networks: A Deep Learning Framework for Solving Forward and Inverse Problems (PINNs)',
      abstract:
        'We introduce physics-informed neural networks -- neural networks that are trained to solve supervised learning tasks while respecting physical conservation laws described by general nonlinear PDEs.',
      year: 2019,
      pub: 'Journal of Computational Physics',
      doi: '10.1016/j.jcp.2018.10.045',
      key: 'raissi2019physics',
      authors: ['M. Raissi', 'P. Perdikaris', 'G.E. Karniadakis'],
    },
    {
      colId: col4.id,
      title:
        'Learning Nonlinear Operators via DeepONet based on the Universal Approximation Theorem',
      abstract:
        'We propose DeepONet, consisting of a branch net for encoding input functions and a trunk net for encoding query coordinates, capable of learning arbitrary non-linear continuous operators.',
      year: 2021,
      pub: 'Nature Machine Intelligence',
      doi: '10.1038/s42256-021-00302-5',
      key: 'lu2021learning',
      authors: [
        'Lu Lu',
        'Pengzhan Jin',
        'Guofei Pang',
        'Zhongqiang Zhang',
        'George Em Karniadakis',
      ],
    },
    {
      colId: col4.id,
      title: 'Neural Ordinary Differential Equations',
      abstract:
        'We introduce a new family of deep neural network models where hidden states are parameterized by the continuous dynamics of ordinary differential equations solved with adaptive black-box ODE solvers.',
      year: 2018,
      pub: 'Advances in Neural Information Processing Systems (NeurIPS)',
      doi: '10.48550/arXiv.1806.07366',
      key: 'chen2018neural',
      authors: [
        'Ricky T. Q. Chen',
        'Yulia Rubanova',
        'Jesse Bettencourt',
        'David Duvenaud',
      ],
    },
    {
      colId: col4.id,
      title: 'Message Passing Neural PDE Solvers',
      abstract:
        'We formulate neural PDE solvers on irregular meshes using temporal bundle message passing to achieve 100x speedup over finite element and volume simulations.',
      year: 2022,
      pub: 'International Conference on Learning Representations (ICLR 2022)',
      doi: '10.48550/arXiv.2202.03376',
      key: 'brandstetter2022message',
      authors: ['Johannes Brandstetter', 'Daniel Worrall', 'Max Welling'],
    },
    {
      colId: col4.id,
      title: 'Geometry-Informed Neural Operator for Large-Scale 3D PDEs (GNO)',
      abstract:
        'We present GNO for learning solution operators of PDEs across complex 3D aerodynamical surfaces, including full aircraft and automotive drag coefficients.',
      year: 2023,
      pub: 'arXiv:2309.00583',
      doi: '10.48550/arXiv.2309.00583',
      key: 'li2023geometry',
      authors: [
        'Zongyi Li',
        'Daniel Zhengyu Huang',
        'Burigede Liu',
        'Anima Anandkumar',
      ],
    },
    {
      colId: col4.id,
      title: 'Learning Mesh-Based Simulation with Graph Networks',
      abstract:
        'We present a general framework for learning physical simulations on meshes using encode-process-decode graph neural networks across aerodynamics and cloth dynamics.',
      year: 2020,
      pub: 'International Conference on Machine Learning (ICML)',
      doi: '10.48550/arXiv.2010.03409',
      key: 'pfaff2020learning',
      authors: [
        'Tobias Pfaff',
        'Meire Fortunato',
        'Alvaro Sanchez-Gonzalez',
        'Peter W. Battaglia',
      ],
    },
  ];

  for (const p of papersData) {
    await prisma.item.create({
      data: {
        title: p.title,
        abstract: p.abstract,
        year: p.year,
        publicationTitle: p.pub,
        doi: p.doi,
        citationKey: p.key,
        userId: userThanh.id,
        projectId: project.id,
        contributors: {
          create: p.authors.map((name, idx) => ({
            creatorType: 'author',
            fullName: name,
            orderIndex: idx,
          })),
        },
        collectionItems: {
          create: [{ collectionId: p.colId }],
        },
      },
    });
  }

  console.log(
    `📚 Seeded ${papersData.length} papers across 4 collections for ${userThanh.email}.`,
  );

  // 8. Seed ItemFieldMapping from Zotero schema v42
  console.log('📖 Seeding item_field_mappings from Zotero schema v42...');
  const fieldMappingRows: Array<{
    itemType: string;
    baseField: string;
    fieldKey: string;
    fieldLabel: string | null;
    orderIndex: number;
  }> = [];

  for (const [itemType, mappings] of Object.entries(
    SCHEMA_V42_DATA.baseFieldMappings,
  )) {
    let orderIndex = 0;
    for (const [baseField, fieldKey] of Object.entries(
      mappings as Record<string, string>,
    )) {
      fieldMappingRows.push({
        itemType,
        baseField,
        fieldKey,
        fieldLabel: null,
        orderIndex: orderIndex++,
      });
    }
  }

  if (fieldMappingRows.length > 0) {
    await prisma.itemFieldMapping.deleteMany();
    await prisma.itemFieldMapping.createMany({
      data: fieldMappingRows,
      skipDuplicates: true,
    });
    console.log(`   ✅ Seeded ${fieldMappingRows.length} field mapping rows.`);
  }

  // 9. Create Comprehensive Manuscript Documents & File Tree (25 files across 7 directories)
  console.log(
    '📝 Seeding full multi-file LaTeX research manuscript (25 files across 7 directories)...',
  );

  // Create folder nodes in hierarchy
  const folderNames = [
    'sections',
    'appendices',
    'tables',
    'algorithms',
    'macros',
    'styles',
    'supplementary',
  ];
  const folderNodesMap = new Map<string, string>();

  for (let i = 0; i < folderNames.length; i++) {
    const fName = folderNames[i];
    const node = await prisma.manuscriptNode.create({
      data: {
        projectId: project.id,
        name: fName,
        path: `/${fName}`,
        type: 'FOLDER',
        depth: 0,
        sortOrder: i + 1,
      },
    });
    folderNodesMap.set(fName, node.id);
  }

  const demoFiles = getDemoBackendFiles('main');
  for (let idx = 0; idx < demoFiles.length; idx++) {
    const f = demoFiles[idx];
    const doc = await prisma.manuscriptDoc.create({
      data: {
        projectId: project.id,
        path: f.path,
        lines: f.content.split('\n'),
        sizeBytes: f.size,
        rev: 1,
        version: 1,
      },
    });

    // Check if file is inside a subfolder
    const segments = f.path.replace(/^\//, '').split('/');
    const isInSubfolder = segments.length > 1;
    const folderKey = isInSubfolder ? segments[0] : null;
    const parentId = folderKey ? folderNodesMap.get(folderKey) : null;
    const fileName = segments[segments.length - 1];

    const isRoot = f.name === 'main.tex';
    await prisma.manuscriptNode.create({
      data: {
        projectId: project.id,
        name: isRoot ? 'flux' : fileName,
        path: f.path,
        type: 'DOC',
        docId: doc.id,
        parentId: parentId || null,
        depth: isInSubfolder ? 1 : 0,
        isRootDoc: isRoot,
        sizeBytes: f.size,
        sortOrder: idx,
      },
    });
  }
  console.log(
    `   ✅ Seeded ${demoFiles.length} LaTeX files into project "${project.name}" (across 7 folders).`,
  );

  // 10. Create 6 Personal Stickies for userThanh
  console.log('📌 Seeding 6 personal stickies for user...');
  const stickiesData = [
    {
      title: 'Demo Technical Monograph (Adam Optimization)',
      content:
        'Overleaf-grade LaTeX workspace loaded with comprehensive 25-file monograph: 10 sections, 4 appendices, 3 algorithms, 3 benchmark tables, and Beamer defense presentation.',
      color: 'blue-1',
      posX: 40,
      posY: 80,
      order: 0,
    },
    {
      title: 'ICLR Camera-Ready Checklist',
      content:
        '1. Re-verify Theorem 1 regret proof in appendix A\n2. Verify 45 BibTeX references against Zotero DOIs\n3. Verify Table 1 FLOPs and latency on 8x H100 SXM5\n4. Recompile with pdftex and bibtex artifact export',
      color: 'yellow-1',
      posX: 340,
      posY: 80,
      order: 1,
    },
    {
      title: 'Distributed Cluster Commands (8x H100)',
      content:
        'torchrun --nproc_per_node=8 --nnodes=1 benchmark.py \\\n  --model vit_base_patch16_224 \\\n  --optimizer adamw \\\n  --lr 1e-3 --warmup_epochs 15 --fp16',
      color: 'green-1',
      posX: 640,
      posY: 80,
      order: 2,
    },
    {
      title: 'Theorem 1 Regret Bound Notation',
      content:
        'Bound: R(T) <= D_inf^2 / (2 alpha (1 - beta_1)) * sum(sqrt(T * v_hat_T)) + alpha (1 + beta_1) G_inf / ((1 - beta_1)^3 sqrt(1 - beta_2)) * sum(||g_{1:T}||_2)',
      color: 'purple-1',
      posX: 940,
      posY: 80,
      order: 3,
    },
    {
      title: 'Zotero & CSL Citation Pipeline',
      content:
        'Library schema: Zotero v42 schema with 72 field mappings.\nCSL Styles: IEEE, Nature, ACM, APA 7th edition supported.',
      color: 'cyan-1',
      posX: 40,
      posY: 340,
      order: 4,
    },
    {
      title: 'Flux Platform Architecture Notes',
      content:
        'Clean Architecture with Hexagonal Ports & Adapters.\nFE: library-services SDK with TanStack Query.\nBE: Fastify + NestJS + Prisma + Redis Outbox.',
      color: 'orange-1',
      posX: 340,
      posY: 340,
      order: 5,
    },
  ];

  for (const s of stickiesData) {
    await prisma.sticky.create({
      data: {
        title: s.title,
        content: s.content,
        color: s.color,
        positionX: s.posX,
        positionY: s.posY,
        order: s.order,
        userId: userThanh.id,
      },
    });
  }

  console.log(`📌 Created 6 personal stickies for ${userThanh.email}.`);

  // 11. Seed Rich Academic Library Dataset & Contexts
  await seedLibrary();

  // 12. Invalidate Redis Caches
  try {
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    const keys = await redis.keys('*work-item*');
    if (keys.length > 0) {
      await redis.del(...keys);
      console.log(`🧹 Flushed ${keys.length} work-item cache keys in Redis.`);
    }
    await redis.quit();
  } catch {
    // Redis optional in standalone seed
  }

  console.log('✅ Enterprise database seeding finished successfully!');
  console.log('🔑 Login Details:');
  console.log(
    `   Owner (Your Account):  ${userThanh.email} (Google OAuth or Password123!)`,
  );
  console.log(
    '   Admin (PI):            admin@rpm.local            / Password123!',
  );
  console.log(
    '   Researcher:            researcher@rpm.local       / Password123!',
  );
  console.log(
    '   Reviewer:              reviewer@rpm.local         / Password123!',
  );
  console.log(
    `📁 Project Name:          ${project.name} (${project.identifier})`,
  );
  console.log('   Manuscript Files:      25 files across 7 nested folders');
  console.log('   Library Papers:        32 papers across 4 collections');
  console.log('   Work Items:            42 tasks across 5 workflow states');
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
