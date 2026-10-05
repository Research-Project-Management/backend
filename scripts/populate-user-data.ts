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
  console.log(
    '🚀 Pushing realistic demo Work Items into user account: ngotanthanh92.26@gmail.com',
  );

  // 1. Fetch user
  const user = await prisma.user.findFirst({
    where: { email: 'ngotanthanh92.26@gmail.com' },
    include: { profile: true },
  });

  if (!user) {
    throw new Error('❌ User ngotanthanh92.26@gmail.com not found!');
  }
  console.log(
    `👤 Target User: ${user.profile?.name || user.email} (ID: ${user.id})`,
  );

  // 2. Fetch collaborator users
  const adminUser = await prisma.user.findFirst({
    where: { email: 'admin@rpm.local' },
  });
  const researcherUser = await prisma.user.findFirst({
    where: { email: 'researcher@rpm.local' },
  });
  const reviewerUser = await prisma.user.findFirst({
    where: { email: 'reviewer@rpm.local' },
  });

  console.log(`👥 Collaborator users:`);
  console.log(`   - Dr. Evelyn Vance: ${adminUser?.id}`);
  console.log(`   - Alex Chen: ${researcherUser?.id}`);
  console.log(`   - Dr. Marcus Brody: ${reviewerUser?.id}`);

  // 3. Project PIDL: Add user as OWNER and assign key work items
  const pidlProject = await prisma.project.findFirst({
    where: { identifier: 'PIDL' },
    include: { workItems: true },
  });

  if (pidlProject) {
    console.log(`\n📁 [1/2] Processing PIDL Project (${pidlProject.id})...`);
    // Upsert membership
    await prisma.projectMember.upsert({
      where: {
        projectId_userId: {
          projectId: pidlProject.id,
          userId: user.id,
        },
      },
      create: {
        projectId: pidlProject.id,
        userId: user.id,
        role: Role.owner,
      },
      update: {
        role: Role.owner,
      },
    });
    console.log(`   ✅ Added ${user.email} as OWNER to project PIDL.`);

    // Assign key items in PIDL to user: PIDL-4, PIDL-7, PIDL-10, PIDL-14
    const keyIdentifiers = ['PIDL-4', 'PIDL-7', 'PIDL-10', 'PIDL-14', 'PIDL-1'];
    for (const ident of keyIdentifiers) {
      const item = await prisma.workItem.findFirst({
        where: { projectId: pidlProject.id, identifier: ident },
        include: { assignees: true },
      });
      if (item) {
        const existingIds = Array.isArray(item.assigneeIds)
          ? (item.assigneeIds as string[])
          : [];
        const newIds = Array.from(new Set([user.id, ...existingIds]));
        await prisma.workItem.update({
          where: { id: item.id },
          data: {
            assigneeId: user.id,
            assigneeIds: newIds,
          },
        });
        await prisma.workItemAssignee.upsert({
          where: {
            workItemId_userId: {
              workItemId: item.id,
              userId: user.id,
            },
          },
          create: {
            workItemId: item.id,
            userId: user.id,
            isPrimary: true,
          },
          update: {
            isPrimary: true,
          },
        });
        console.log(`   🎯 Assigned ${ident} to ${user.email}`);
      }
    }
  }

  // 4. Project FLUX: Populate states, labels, members, and full realistic work items
  const fluxProject = await prisma.project.findFirst({
    where: { identifier: 'FLUX' },
    include: { states: true, workItemLabels: true, members: true },
  });

  if (fluxProject) {
    console.log(
      `\n📁 [2/2] Processing user personal FLUX Project (${fluxProject.id})...`,
    );

    // Ensure collaborators are in FLUX project for rich teamwork mockup
    if (adminUser) {
      await prisma.projectMember.upsert({
        where: {
          projectId_userId: { projectId: fluxProject.id, userId: adminUser.id },
        },
        create: {
          projectId: fluxProject.id,
          userId: adminUser.id,
          role: Role.contributor,
        },
        update: {},
      });
    }
    if (researcherUser) {
      await prisma.projectMember.upsert({
        where: {
          projectId_userId: {
            projectId: fluxProject.id,
            userId: researcherUser.id,
          },
        },
        create: {
          projectId: fluxProject.id,
          userId: researcherUser.id,
          role: Role.contributor,
        },
        update: {},
      });
    }
    if (reviewerUser) {
      await prisma.projectMember.upsert({
        where: {
          projectId_userId: {
            projectId: fluxProject.id,
            userId: reviewerUser.id,
          },
        },
        create: {
          projectId: fluxProject.id,
          userId: reviewerUser.id,
          role: Role.reviewer,
        },
        update: {},
      });
    }

    // Ensure 6 states exist in FLUX
    let stateBacklog = fluxProject.states.find((s) => s.group === 'backlog');
    let stateTodo = fluxProject.states.find((s) => s.group === 'unstarted');
    let stateInProgress = fluxProject.states.find(
      (s) => s.group === 'started' && !s.name.toLowerCase().includes('review'),
    );
    let stateReview = fluxProject.states.find((s) =>
      s.name.toLowerCase().includes('review'),
    );
    let stateDone = fluxProject.states.find((s) => s.group === 'completed');
    let stateCancelled = fluxProject.states.find(
      (s) => s.group === 'cancelled',
    );

    if (!stateReview) {
      stateReview = await prisma.workItemState.create({
        data: {
          projectId: fluxProject.id,
          name: 'Under Review',
          color: '#D97706',
          group: 'started',
          sequence: 3500,
          isDefault: false,
          description: 'Items under peer/faculty review',
        },
      });
    }

    console.log('   ✅ Workflow States ready in FLUX.');

    // Clear any previous work items in FLUX if needed
    await prisma.workItemComment.deleteMany({
      where: { workItem: { projectId: fluxProject.id } },
    });
    await prisma.workItemLabelAssignment.deleteMany({
      where: { workItem: { projectId: fluxProject.id } },
    });
    await prisma.workItemAssignee.deleteMany({
      where: { workItem: { projectId: fluxProject.id } },
    });
    await prisma.workItem.deleteMany({ where: { projectId: fluxProject.id } });
    await prisma.workItemLabel.deleteMany({
      where: { projectId: fluxProject.id },
    });

    // Seed Labels
    const labelsData = [
      {
        name: 'Deep Learning',
        color: '#3B82F6',
        description: 'Neural operator models and deep learning architectures',
        sortOrder: 1,
      },
      {
        name: 'Fluid Dynamics',
        color: '#06B6D4',
        description: 'Navier-Stokes, turbulence, and vorticity physics',
        sortOrder: 2,
      },
      {
        name: 'Loss Function',
        color: '#8B5CF6',
        description: 'Physics penalties, Sobolev norms, and boundary terms',
        sortOrder: 3,
      },
      {
        name: 'LaTeX Manuscript',
        color: '#10B981',
        description: 'Paper drafting, figures, and CLSI compilation',
        sortOrder: 4,
      },
      {
        name: 'GPU Optimization',
        color: '#F59E0B',
        description: 'CUDA, DDP, multi-GPU scaling, and memory efficiency',
        sortOrder: 5,
      },
      {
        name: 'BibTeX / Citations',
        color: '#EC4899',
        description: 'Reference management and literature integration',
        sortOrder: 6,
      },
      {
        name: 'Peer Review',
        color: '#F97316',
        description: 'Reviewer comments, rebuttals, and revisions',
        sortOrder: 7,
      },
      {
        name: 'Benchmark',
        color: '#6366F1',
        description: 'Performance comparison against DNS solvers',
        sortOrder: 8,
      },
    ];

    const labelMap = new Map<string, string>();
    for (const l of labelsData) {
      const created = await prisma.workItemLabel.create({
        data: {
          ...l,
          projectId: fluxProject.id,
          createdById: user.id,
        },
      });
      labelMap.set(l.name, created.id);
    }
    console.log(`   🏷️ Seeded ${labelMap.size} taxonomy labels in FLUX.`);

    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;

    const assignLabel = async (wiId: string, labelName: string) => {
      const lblId = labelMap.get(labelName);
      if (lblId) {
        await prisma.workItemLabelAssignment.create({
          data: { workItemId: wiId, labelId: lblId },
        });
      }
    };

    const assignMember = async (
      wiId: string,
      userId: string,
      isPrimary = false,
    ) => {
      await prisma.workItemAssignee.create({
        data: { workItemId: wiId, userId, isPrimary },
      });
    };

    // ── 1. Backlog ──────────────────────────────────────────────────────────
    const w1 = await prisma.workItem.create({
      data: {
        sequenceNumber: 1,
        identifier: 'FLUX-1',
        title:
          'Investigate Fourier Neural Operator scaling on 3D turbulent channel flow',
        content:
          'Explore parameter efficiency and zero-shot mesh-independence when scaling from 2D Kolmogorov turbulence to 3D channel flow with Reynolds number up to Re=10,000.',
        columnId: stateBacklog!.id,
        priority: WorkItemPriority.medium,
        rank: 1000,
        labels: [
          labelMap.get('Deep Learning')!,
          labelMap.get('Fluid Dynamics')!,
        ],
        authorId: user.id,
        assigneeId: user.id,
        assigneeIds: [user.id, researcherUser?.id].filter(Boolean) as string[],
        projectId: fluxProject.id,
        completed: false,
      },
    });
    await assignLabel(w1.id, 'Deep Learning');
    await assignLabel(w1.id, 'Fluid Dynamics');
    await assignMember(w1.id, user.id, true);
    if (researcherUser) await assignMember(w1.id, researcherUser.id, false);

    const w2 = await prisma.workItem.create({
      data: {
        sequenceNumber: 2,
        identifier: 'FLUX-2',
        title:
          'Benchmark DeepONet vs Fourier Neural Operator on 1D Burgers equation',
        content:
          'Perform convergence rate comparison over viscous shock formation regimes. Measure relative L2 error vs training epoch count.',
        columnId: stateBacklog!.id,
        priority: WorkItemPriority.low,
        rank: 2000,
        labels: [labelMap.get('Deep Learning')!, labelMap.get('Benchmark')!],
        authorId: user.id,
        projectId: fluxProject.id,
        completed: false,
      },
    });
    await assignLabel(w2.id, 'Deep Learning');
    await assignLabel(w2.id, 'Benchmark');

    const w3 = await prisma.workItem.create({
      data: {
        sequenceNumber: 3,
        identifier: 'FLUX-3',
        title:
          'Evaluate FP16 mixed precision vs BF16 gradient stability on A100 GPUs',
        content:
          'Profile PyTorch AMP under high Sobolev penalty regimes to prevent underflow during second-order derivative backpropagation.',
        columnId: stateBacklog!.id,
        priority: WorkItemPriority.none,
        rank: 3000,
        labels: [labelMap.get('GPU Optimization')!],
        authorId: user.id,
        projectId: fluxProject.id,
        completed: false,
      },
    });
    await assignLabel(w3.id, 'GPU Optimization');

    // ── 2. To Do ─────────────────────────────────────────────────────────────
    const w4 = await prisma.workItem.create({
      data: {
        sequenceNumber: 4,
        identifier: 'FLUX-4',
        title:
          'Derive boundary condition loss penalty for non-slip wall constraints',
        content:
          'Formulate Neumann and Dirichlet boundary loss terms along physical domain walls to prevent non-zero slip velocity artifacts in vorticity contour plots.',
        columnId: stateTodo!.id,
        priority: WorkItemPriority.high,
        rank: 1000,
        labels: [
          labelMap.get('Fluid Dynamics')!,
          labelMap.get('Loss Function')!,
        ],
        startDate: new Date(now.getTime() + 1 * dayMs),
        dueDate: new Date(now.getTime() + 5 * dayMs),
        authorId: user.id,
        assigneeId: user.id,
        assigneeIds: [user.id],
        projectId: fluxProject.id,
        completed: false,
      },
    });
    await assignLabel(w4.id, 'Fluid Dynamics');
    await assignLabel(w4.id, 'Loss Function');
    await assignMember(w4.id, user.id, true);

    const w5 = await prisma.workItem.create({
      data: {
        sequenceNumber: 5,
        identifier: 'FLUX-5',
        title:
          'Export BibTeX citations from Zotero collection for related works section',
        content:
          'Synchronize 18 papers from the Neural Operators collection into references.bib and verify citation keys in abstract.tex and methodology.tex.',
        columnId: stateTodo!.id,
        priority: WorkItemPriority.medium,
        rank: 2000,
        labels: [
          labelMap.get('BibTeX / Citations')!,
          labelMap.get('LaTeX Manuscript')!,
        ],
        dueDate: new Date(now.getTime() + 3 * dayMs),
        authorId: user.id,
        assigneeId: adminUser?.id || user.id,
        assigneeIds: [adminUser?.id || user.id],
        projectId: fluxProject.id,
        completed: false,
      },
    });
    await assignLabel(w5.id, 'BibTeX / Citations');
    await assignLabel(w5.id, 'LaTeX Manuscript');
    await assignMember(w5.id, adminUser?.id || user.id, true);

    const w6 = await prisma.workItem.create({
      data: {
        sequenceNumber: 6,
        identifier: 'FLUX-6',
        title:
          'Configure multi-node Slurm job scripts for distributed DDP training',
        content:
          'Write sbatch submission template with NCCL environment flags for 4x A100 SXM4 80GB nodes on cluster.',
        columnId: stateTodo!.id,
        priority: WorkItemPriority.high,
        rank: 3000,
        labels: [labelMap.get('GPU Optimization')!],
        startDate: new Date(now.getTime() + 2 * dayMs),
        dueDate: new Date(now.getTime() + 7 * dayMs),
        authorId: user.id,
        assigneeId: researcherUser?.id || user.id,
        assigneeIds: [researcherUser?.id || user.id],
        projectId: fluxProject.id,
        completed: false,
      },
    });
    await assignLabel(w6.id, 'GPU Optimization');
    await assignMember(w6.id, researcherUser?.id || user.id, true);

    // ── 3. In Progress ───────────────────────────────────────────────────────
    const w7 = await prisma.workItem.create({
      data: {
        sequenceNumber: 7,
        identifier: 'FLUX-7',
        title: 'Implement H1 Sobolev norm regularization in loss function',
        content:
          'Add gradient penalty to enforce conservation of vorticity in Navier-Stokes 2D box test cases. Suppresses spurious high-frequency spectral noise.',
        columnId: stateInProgress!.id,
        priority: WorkItemPriority.urgent,
        rank: 1000,
        labels: [
          labelMap.get('Deep Learning')!,
          labelMap.get('Loss Function')!,
        ],
        startDate: new Date(now.getTime() - 2 * dayMs),
        dueDate: new Date(now.getTime() + 1 * dayMs),
        authorId: user.id,
        assigneeId: user.id,
        assigneeIds: [user.id, adminUser?.id].filter(Boolean) as string[],
        projectId: fluxProject.id,
        completed: false,
      },
    });
    await assignLabel(w7.id, 'Deep Learning');
    await assignLabel(w7.id, 'Loss Function');
    await assignMember(w7.id, user.id, true);
    if (adminUser) await assignMember(w7.id, adminUser.id, false);

    // Sub-items for FLUX-7
    await prisma.workItem.create({
      data: {
        sequenceNumber: 16,
        identifier: 'FLUX-16',
        title: 'Formulate finite-difference gradient operator for vorticity',
        columnId: stateDone!.id,
        priority: WorkItemPriority.high,
        rank: 100,
        authorId: user.id,
        assigneeId: user.id,
        parentWorkItemId: w7.id,
        projectId: fluxProject.id,
        completed: true,
      },
    });

    await prisma.workItem.create({
      data: {
        sequenceNumber: 17,
        identifier: 'FLUX-17',
        title:
          'Implement vectorized H1 norm PyTorch custom autograd loss module',
        columnId: stateDone!.id,
        priority: WorkItemPriority.urgent,
        rank: 200,
        authorId: user.id,
        assigneeId: user.id,
        parentWorkItemId: w7.id,
        projectId: fluxProject.id,
        completed: true,
      },
    });

    await prisma.workItem.create({
      data: {
        sequenceNumber: 18,
        identifier: 'FLUX-18',
        title:
          'Validate loss backpropagation on 2D Taylor-Green vortex benchmark',
        columnId: stateInProgress!.id,
        priority: WorkItemPriority.medium,
        rank: 300,
        authorId: user.id,
        assigneeId: user.id,
        parentWorkItemId: w7.id,
        projectId: fluxProject.id,
        completed: false,
      },
    });

    // Comments for FLUX-7
    if (adminUser) {
      await prisma.workItemComment.create({
        data: {
          workItemId: w7.id,
          authorId: adminUser.id,
          content:
            'The vorticity gradient penalty significantly reduces unphysical oscillations near the high-Reynolds boundary layer.',
        },
      });
    }
    await prisma.workItemComment.create({
      data: {
        workItemId: w7.id,
        authorId: user.id,
        content:
          'Benchmarking against the spectral DNS solver right now. Initial runs demonstrate a 4.2x speedup and lower L2 relative error.',
      },
    });

    const w8 = await prisma.workItem.create({
      data: {
        sequenceNumber: 8,
        identifier: 'FLUX-8',
        title: 'Draft Section 3 (Methodology & Architecture) in main.tex',
        content:
          'Draft mathematical formulation of the Fourier integral kernel and include high-resolution architecture diagrams.',
        columnId: stateInProgress!.id,
        priority: WorkItemPriority.high,
        rank: 2000,
        labels: [labelMap.get('LaTeX Manuscript')!],
        startDate: new Date(now.getTime() - 1 * dayMs),
        dueDate: new Date(now.getTime() + 4 * dayMs),
        authorId: user.id,
        assigneeId: adminUser?.id || user.id,
        assigneeIds: [adminUser?.id || user.id],
        projectId: fluxProject.id,
        completed: false,
      },
    });
    await assignLabel(w8.id, 'LaTeX Manuscript');
    await assignMember(w8.id, adminUser?.id || user.id, true);

    // Sub-items for FLUX-8
    await prisma.workItem.create({
      data: {
        sequenceNumber: 19,
        identifier: 'FLUX-19',
        title: 'Write Neural Operator continuous formulation proofs',
        columnId: stateDone!.id,
        priority: WorkItemPriority.medium,
        rank: 100,
        authorId: user.id,
        parentWorkItemId: w8.id,
        projectId: fluxProject.id,
        completed: true,
      },
    });

    await prisma.workItem.create({
      data: {
        sequenceNumber: 20,
        identifier: 'FLUX-20',
        title: 'Generate TikZ neural operator architecture block diagrams',
        columnId: stateInProgress!.id,
        priority: WorkItemPriority.high,
        rank: 200,
        authorId: user.id,
        parentWorkItemId: w8.id,
        projectId: fluxProject.id,
        completed: false,
      },
    });

    const w9 = await prisma.workItem.create({
      data: {
        sequenceNumber: 9,
        identifier: 'FLUX-9',
        title:
          'Optimize FFT kernel memory footprint with FlashAttention Fourier blocks',
        content:
          'Refactor complex-valued matrix multiplication in Fourier space into fused memory kernels to fit batch size 64 into 40GB VRAM.',
        columnId: stateInProgress!.id,
        priority: WorkItemPriority.medium,
        rank: 3000,
        labels: [
          labelMap.get('Deep Learning')!,
          labelMap.get('GPU Optimization')!,
        ],
        startDate: new Date(now.getTime() - 3 * dayMs),
        dueDate: new Date(now.getTime() + 2 * dayMs),
        authorId: user.id,
        assigneeId: researcherUser?.id || user.id,
        assigneeIds: [researcherUser?.id || user.id],
        projectId: fluxProject.id,
        completed: false,
      },
    });
    await assignLabel(w9.id, 'Deep Learning');
    await assignLabel(w9.id, 'GPU Optimization');
    await assignMember(w9.id, researcherUser?.id || user.id, true);

    // ── 4. Under Review ──────────────────────────────────────────────────────
    const w10 = await prisma.workItem.create({
      data: {
        sequenceNumber: 10,
        identifier: 'FLUX-10',
        title:
          'Conduct Taylor-Green vortex stability benchmarking across Reynolds 1600-5000',
        content:
          'Compute kinetic energy dissipation rate spectrum against Nek5000 spectral element solver outputs.',
        columnId: stateReview.id,
        priority: WorkItemPriority.high,
        rank: 1000,
        labels: [labelMap.get('Benchmark')!, labelMap.get('Fluid Dynamics')!],
        dueDate: new Date(now.getTime() + 2 * dayMs),
        authorId: user.id,
        assigneeId: user.id,
        assigneeIds: [user.id, reviewerUser?.id].filter(Boolean) as string[],
        projectId: fluxProject.id,
        completed: false,
      },
    });
    await assignLabel(w10.id, 'Benchmark');
    await assignLabel(w10.id, 'Fluid Dynamics');
    await assignMember(w10.id, user.id, true);
    if (reviewerUser) await assignMember(w10.id, reviewerUser.id, false);

    if (reviewerUser) {
      await prisma.workItemComment.create({
        data: {
          workItemId: w10.id,
          authorId: reviewerUser.id,
          content:
            'Dissipation curve matches Nek5000 within 1.8% relative error up to t=10. Please include enstrophy comparison plot before final sign-off.',
        },
      });
    }

    const w11 = await prisma.workItem.create({
      data: {
        sequenceNumber: 11,
        identifier: 'FLUX-11',
        title: 'Review peer reviewer comments on Section 2 literature review',
        content:
          'Incorporate discussion of recent U-FNO and Geo-FNO neural operator architectures published in NeurIPS 2025.',
        columnId: stateReview.id,
        priority: WorkItemPriority.medium,
        rank: 2000,
        labels: [
          labelMap.get('Peer Review')!,
          labelMap.get('LaTeX Manuscript')!,
        ],
        dueDate: new Date(now.getTime() + 1 * dayMs),
        authorId: user.id,
        assigneeId: adminUser?.id || user.id,
        assigneeIds: [adminUser?.id || user.id],
        projectId: fluxProject.id,
        completed: false,
      },
    });
    await assignLabel(w11.id, 'Peer Review');
    await assignLabel(w11.id, 'LaTeX Manuscript');
    await assignMember(w11.id, adminUser?.id || user.id, true);

    // ── 5. Completed ─────────────────────────────────────────────────────────
    const w12 = await prisma.workItem.create({
      data: {
        sequenceNumber: 12,
        identifier: 'FLUX-12',
        title:
          'Prepare synthetic DNS 2D Kolmogorov turbulence dataset at 512x512 resolution',
        content:
          'Generated 1,200 trajectories with forced turbulence in HDF5 format with trajectory checkpointing.',
        columnId: stateDone!.id,
        priority: WorkItemPriority.high,
        rank: 1000,
        labels: [
          labelMap.get('Fluid Dynamics')!,
          labelMap.get('Deep Learning')!,
        ],
        startDate: new Date(now.getTime() - 10 * dayMs),
        dueDate: new Date(now.getTime() - 4 * dayMs),
        authorId: user.id,
        assigneeId: user.id,
        assigneeIds: [user.id],
        projectId: fluxProject.id,
        completed: true,
      },
    });
    await assignLabel(w12.id, 'Fluid Dynamics');
    await assignLabel(w12.id, 'Deep Learning');
    await assignMember(w12.id, user.id, true);

    const w13 = await prisma.workItem.create({
      data: {
        sequenceNumber: 13,
        identifier: 'FLUX-13',
        title:
          'Setup automated PyTorch Lightning training pipeline and Weights & Biases telemetry',
        content:
          'Integrated loss metrics, learning rate schedules, gradient clipping, and spectral error checkpoints into wandb dashboard.',
        columnId: stateDone!.id,
        priority: WorkItemPriority.urgent,
        rank: 2000,
        labels: [labelMap.get('GPU Optimization')!],
        startDate: new Date(now.getTime() - 8 * dayMs),
        dueDate: new Date(now.getTime() - 2 * dayMs),
        authorId: user.id,
        assigneeId: researcherUser?.id || user.id,
        assigneeIds: [researcherUser?.id || user.id],
        projectId: fluxProject.id,
        completed: true,
      },
    });
    await assignLabel(w13.id, 'GPU Optimization');
    await assignMember(w13.id, researcherUser?.id || user.id, true);

    const w14 = await prisma.workItem.create({
      data: {
        sequenceNumber: 14,
        identifier: 'FLUX-14',
        title: 'Synchronize Zotero references collection with CLSI compiler',
        content:
          'Verified CSL citation styles and resolved 4 duplicate citation key conflicts in main.bib.',
        columnId: stateDone!.id,
        priority: WorkItemPriority.medium,
        rank: 3000,
        labels: [labelMap.get('BibTeX / Citations')!],
        startDate: new Date(now.getTime() - 5 * dayMs),
        dueDate: new Date(now.getTime() - 1 * dayMs),
        authorId: user.id,
        assigneeId: adminUser?.id || user.id,
        assigneeIds: [adminUser?.id || user.id],
        projectId: fluxProject.id,
        completed: true,
      },
    });
    await assignLabel(w14.id, 'BibTeX / Citations');
    await assignMember(w14.id, adminUser?.id || user.id, true);

    // ── 6. Cancelled ─────────────────────────────────────────────────────────
    const w15 = await prisma.workItem.create({
      data: {
        sequenceNumber: 15,
        identifier: 'FLUX-15',
        title:
          'Evaluate legacy feed-forward MLP baseline with Cartesian coordinate embeddings',
        content:
          'Abandoned due to poor generalization on high-frequency turbulent structures compared to spectral Fourier operators.',
        columnId: stateCancelled!.id,
        priority: WorkItemPriority.low,
        rank: 1000,
        labels: [labelMap.get('Benchmark')!],
        authorId: user.id,
        projectId: fluxProject.id,
        completed: false,
      },
    });
    await assignLabel(w15.id, 'Benchmark');

    // Update workItemSequence on FLUX project
    await prisma.project.update({
      where: { id: fluxProject.id },
      data: { workItemSequence: 21 },
    });

    console.log(`   ✅ Successfully seeded 20 Work Items in project FLUX.`);
  }

  // 5. Invalidate Redis Caches
  try {
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    const keys = await redis.keys('*work-item*');
    const wiKeys = await redis.keys('flux:wi:*');
    const projectKeys = await redis.keys('*project*');
    const allKeys = Array.from(new Set([...keys, ...wiKeys, ...projectKeys]));

    if (allKeys.length > 0) {
      await redis.del(...allKeys);
      console.log(`🧹 Flushed ${allKeys.length} Redis cache keys.`);
    }
    await redis.quit();
  } catch (err) {
    console.warn(
      '⚠️ Warning clearing Redis (can be ignored if redis is not running):',
      err,
    );
  }

  console.log(
    '\n🎉 ALL DONE! Work Items have been pushed to ngotanthanh92.26@gmail.com on both FLUX and PIDL projects.',
  );
}

run()
  .catch((e) => {
    console.error('❌ Error executing population script:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
