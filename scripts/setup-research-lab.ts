import 'dotenv/config';
import { PrismaClient, Role, WorkItemPriority } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import Redis from 'ioredis';
import { getDemoBackendFiles } from '../src/modules/manuscripts/shared/demo-manuscript.constant';

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://postgres:Thanh26102006@localhost:5433/flux-db?schema=public',
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function run() {
  console.log(
    '🔬 Transforming workspace into a top-tier Scientific Research Lab...',
  );
  const passwordHash = await bcrypt.hash('Password123!', 10);

  // 1. Update/Ensure Lab Director User (GS. TS. Ngô Tấn Thành)
  let ownerUser = await prisma.user.findFirst({
    where: { email: 'ngotanthanh92.26@gmail.com' },
    include: { profile: true },
  });

  if (!ownerUser) {
    ownerUser = await prisma.user.create({
      data: {
        email: 'ngotanthanh92.26@gmail.com',
        password: passwordHash,
        status: 'active',
        profile: {
          create: {
            name: 'GS. TS. Ngô Tấn Thành',
            institution:
              'Flux Laboratory for Neural Computing & Scientific AI (PI / Lab Director)',
          },
        },
      },
      include: { profile: true },
    });
  } else {
    await prisma.userProfile.upsert({
      where: { userId: ownerUser.id },
      create: {
        userId: ownerUser.id,
        name: 'GS. TS. Ngô Tấn Thành',
        institution:
          'Flux Laboratory for Neural Computing & Scientific AI (PI / Lab Director)',
      },
      update: {
        name: 'GS. TS. Ngô Tấn Thành',
        institution:
          'Flux Laboratory for Neural Computing & Scientific AI (PI / Lab Director)',
      },
    });
  }
  console.log(
    `👑 Lab Owner / Director: GS. TS. Ngô Tấn Thành (${ownerUser.email}, ID: ${ownerUser.id})`,
  );

  // 2. Ensure Research Team Members
  const ensureMember = async (
    email: string,
    name: string,
    institution: string,
    avatar?: string,
  ) => {
    let u = await prisma.user.findFirst({
      where: { email },
      include: { profile: true },
    });
    if (!u) {
      u = await prisma.user.create({
        data: {
          email,
          password: passwordHash,
          status: 'active',
          profile: {
            create: {
              name,
              institution,
              avatar:
                avatar ||
                'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
            },
          },
        },
        include: { profile: true },
      });
    } else {
      await prisma.userProfile.update({
        where: { userId: u.id },
        data: { name, institution, ...(avatar ? { avatar } : {}) },
      });
    }
    return u;
  };

  const coPiUser = await ensureMember(
    'admin@rpm.local',
    'Dr. Evelyn Vance',
    'Flux Lab (Co-PI & Head of Mathematical Modeling)',
    'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
  );

  const postDocUser = await ensureMember(
    'researcher@rpm.local',
    'Dr. Alex Chen',
    'Flux Lab (Senior Postdoctoral Fellow in Deep Learning)',
    'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
  );

  const reviewerUser = await ensureMember(
    'reviewer@rpm.local',
    'GS. Marcus Brody',
    'MIT / Cambridge Fluid Dynamics (External Advisory Board & Reviewer)',
    'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150',
  );

  const phdUser = await ensureMember(
    's.jenkins@fluxlab.ai',
    'Sarah Jenkins, M.Sc.',
    'Flux Lab (Ph.D. Candidate in Computational Physics)',
    'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150',
  );

  const raUser = await ensureMember(
    'minh.vu@fluxlab.ai',
    'Minh Vũ, B.S.',
    'Flux Lab (Research Assistant & HPC Systems Engineer)',
    'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=150',
  );

  console.log('👥 Research Team members ready:');
  console.log('   - GS. TS. Ngô Tấn Thành (PI / Lab Director)');
  console.log('   - Dr. Evelyn Vance (Co-PI)');
  console.log('   - Dr. Alex Chen (Senior Postdoc)');
  console.log('   - GS. Marcus Brody (Advisory Board)');
  console.log('   - Sarah Jenkins, M.Sc. (Ph.D. Candidate)');
  console.log('   - Minh Vũ, B.S. (Research Assistant & HPC)');

  // 3. Configure Flagship Lab Project: FLUX
  let fluxProject = await prisma.project.findFirst({
    where: { identifier: 'FLUX' },
  });
  if (fluxProject) {
    await prisma.project.update({
      where: { id: fluxProject.id },
      data: {
        name: 'Flux Neural Dynamics & AI Research Laboratory',
        description:
          'Phòng Thí Nghiệm Trọng Điểm Trí Tuệ Nhân Tạo & Tính Toán Khoa Học (Flux Lab). Chủ nhiệm Lab: GS. TS. Ngô Tấn Thành. Lĩnh vực nghiên cứu: Physics-Informed Neural Operators (PINO/FNO), High-Performance GPU Computing, và Mô hình hóa dòng chảy rối Navier-Stokes.',
        createdById: ownerUser.id,
      },
    });
  } else {
    fluxProject = await prisma.project.create({
      data: {
        name: 'Flux Neural Dynamics & AI Research Laboratory',
        identifier: 'FLUX',
        description:
          'Phòng Thí Nghiệm Trọng Điểm Trí Tuệ Nhân Tạo & Tính Toán Khoa Học (Flux Lab). Chủ nhiệm Lab: GS. TS. Ngô Tấn Thành. Lĩnh vực nghiên cứu: Physics-Informed Neural Operators (PINO/FNO), High-Performance GPU Computing, và Mô hình hóa dòng chảy rối Navier-Stokes.',
        createdById: ownerUser.id,
        workItemSequence: 21,
      },
    });
  }

  // 4. Configure Major Research Grant Project: PIDL
  let pidlProject = await prisma.project.findFirst({
    where: { identifier: 'PIDL' },
  });
  if (pidlProject) {
    await prisma.project.update({
      where: { id: pidlProject.id },
      data: {
        name: 'Physics-Informed Deep Learning for Navier-Stokes (PIDL Grant)',
        description:
          'Đề tài nghiên cứu cấp quốc tế tài trợ cho Flux Lab do GS. TS. Ngô Tấn Thành chủ trì. Ứng dụng Fourier Neural Operators (FNO) và đạo hàm tổn thất Sobolev tăng tốc giải bài toán cơ học chất lưu 1000x.',
        createdById: ownerUser.id,
      },
    });
  }

  // Helper to add all 6 members to project
  const setupProjectMembers = async (projectId: string) => {
    const roster = [
      { userId: ownerUser!.id, role: Role.owner },
      { userId: coPiUser.id, role: Role.owner },
      { userId: postDocUser.id, role: Role.contributor },
      { userId: reviewerUser.id, role: Role.reviewer },
      { userId: phdUser.id, role: Role.contributor },
      { userId: raUser.id, role: Role.contributor },
    ];
    for (const m of roster) {
      await prisma.projectMember.upsert({
        where: { projectId_userId: { projectId, userId: m.userId } },
        create: { projectId, userId: m.userId, role: m.role },
        update: { role: m.role },
      });
    }
  };

  await setupProjectMembers(fluxProject.id);
  if (pidlProject) await setupProjectMembers(pidlProject.id);
  console.log('🏢 Project memberships established for both Lab spaces.');

  // 5. Setup Workflow States in FLUX
  const ensureStates = async (projectId: string) => {
    const statesDef = [
      {
        id: `${projectId}_backlog`,
        name: 'Backlog',
        color: '#6B7280',
        group: 'backlog',
        sequence: 1000,
        isDefault: false,
        description: 'Đề tài & nhiệm vụ nghiên cứu chuẩn bị khởi động',
      },
      {
        id: `${projectId}_todo`,
        name: 'To Do',
        color: '#94A3B8',
        group: 'unstarted',
        sequence: 2000,
        isDefault: true,
        description: 'Nhiệm vụ đã duyệt kế hoạch, sẵn sàng thực hiện',
      },
      {
        id: `${projectId}_inprogress`,
        name: 'In Progress',
        color: '#D97706',
        group: 'started',
        sequence: 3000,
        isDefault: false,
        description: 'Đang triển khai thử nghiệm & viết mã nguồn',
      },
      {
        id: `${projectId}_review`,
        name: 'Under Review',
        color: '#D97706',
        group: 'started',
        sequence: 4000,
        isDefault: false,
        description: 'Đang thẩm định phản biện / Hội đồng nghiệm thu',
      },
      {
        id: `${projectId}_done`,
        name: 'Completed',
        color: '#1A7F37',
        group: 'completed',
        sequence: 5000,
        isDefault: false,
        description: 'Đã nghiệm thu & xuất bản thành công',
      },
      {
        id: `${projectId}_cancelled`,
        name: 'Cancelled',
        color: '#9CA3AF',
        group: 'cancelled',
        sequence: 6000,
        isDefault: false,
        description: 'Hủy hoặc chuyển hướng phương pháp luận',
      },
    ];

    const currentStates = await prisma.workItemState.findMany({
      where: { projectId },
    });
    const stateMap = new Map<string, string>();

    for (const s of statesDef) {
      const match = currentStates.find(
        (cs) =>
          cs.name.toLowerCase() === s.name.toLowerCase() ||
          cs.group === s.group,
      );
      if (match) {
        stateMap.set(s.name, match.id);
      } else {
        const created = await prisma.workItemState.create({
          data: {
            projectId,
            name: s.name,
            color: s.color,
            group: s.group,
            sequence: s.sequence,
            isDefault: s.isDefault,
            description: s.description,
          },
        });
        stateMap.set(s.name, created.id);
      }
    }
    return stateMap;
  };

  const fluxStateMap = await ensureStates(fluxProject.id);

  // 6. Setup Academic & Lab Taxonomy Labels in FLUX
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

  const labelsDef = [
    {
      name: 'Core AI / Deep Learning',
      color: '#3B82F6',
      description: 'Kiến trúc Neural Operators, Transformer & PINO',
    },
    {
      name: 'Fluid Mechanics',
      color: '#06B6D4',
      description: 'Mô phỏng dòng rối Navier-Stokes & Động lực học chất lưu',
    },
    {
      name: 'Grant & Funding',
      color: '#10B981',
      description: 'Đề tài tài trợ nghiên cứu NAFOSTED & NSF Grand Challenge',
    },
    {
      name: 'LaTeX Manuscript',
      color: '#8B5CF6',
      description: 'Soạn thảo bài báo khoa học, hình vẽ TikZ & phản biện',
    },
    {
      name: 'GPU Cluster & HPC',
      color: '#F59E0B',
      description: 'Cụm máy chủ GPU A100/H100, Slurm DDP & tối ưu CUDA',
    },
    {
      name: 'BibTeX & Zotero',
      color: '#EC4899',
      description: 'Quản lý tài liệu tham khảo & trích dẫn học thuật',
    },
    {
      name: 'Peer Review',
      color: '#F97316',
      description: 'Phản biện tạp chí Q1 (JFM, JCP, NeurIPS, ICML)',
    },
    {
      name: 'Lab Operations',
      color: '#6366F1',
      description: 'Tuyển sinh nghiên cứu sinh, bảo trì lab & báo cáo giao ban',
    },
  ];

  const labelMap = new Map<string, string>();
  for (let i = 0; i < labelsDef.length; i++) {
    const l = labelsDef[i];
    const created = await prisma.workItemLabel.create({
      data: {
        name: l.name,
        color: l.color,
        description: l.description,
        sortOrder: i + 1,
        projectId: fluxProject.id,
        createdById: ownerUser.id,
      },
    });
    labelMap.set(l.name, created.id);
  }
  console.log(`🏷️ Created ${labelMap.size} Lab taxonomy labels.`);

  // Helpers
  const assignLabel = async (wiId: string, name: string) => {
    const id = labelMap.get(name);
    if (id)
      await prisma.workItemLabelAssignment.create({
        data: { workItemId: wiId, labelId: id },
      });
  };
  const assignUser = async (wiId: string, uId: string, isPrimary = false) => {
    await prisma.workItemAssignee.create({
      data: { workItemId: wiId, userId: uId, isPrimary },
    });
  };

  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;

  // 7. Seed 20 Authentic Research Lab Work Items (Flagship Project FLUX)
  console.log('📋 Seeding comprehensive Research Lab Work Items...');

  // ── BACKLOG ─────────────────────────────────────────────────────────────
  const w1 = await prisma.workItem.create({
    data: {
      sequenceNumber: 1,
      identifier: 'FLUX-1',
      title:
        '[Grant Proposal] Hoàn thiện hồ sơ tài trợ NAFOSTED & NSF AI Grand Challenge 2026',
      content:
        'Chủ nhiệm GS. TS. Ngô Tấn Thành dẫn dắt viết thuyết minh đề tài: "Ứng dụng Trí tuệ Nhân tạo Vật lý vào Dự báo Biến đổi Khí hậu và Thủy động lực học phức tạp". Dự toán ngân sách mua bổ sung 8 card GPU NVIDIA H100 80GB.',
      columnId: fluxStateMap.get('Backlog')!,
      priority: WorkItemPriority.urgent,
      rank: 1000,
      labels: [
        labelMap.get('Grant & Funding')!,
        labelMap.get('Lab Operations')!,
      ],
      authorId: ownerUser.id,
      assigneeId: ownerUser.id,
      assigneeIds: [ownerUser.id, coPiUser.id],
      projectId: fluxProject.id,
      completed: false,
    },
  });
  await assignLabel(w1.id, 'Grant & Funding');
  await assignLabel(w1.id, 'Lab Operations');
  await assignUser(w1.id, ownerUser.id, true);
  await assignUser(w1.id, coPiUser.id, false);

  const w2 = await prisma.workItem.create({
    data: {
      sequenceNumber: 2,
      identifier: 'FLUX-2',
      title:
        'Khảo sát mô hình Foundation Models cho Khoa học Tự nhiên (Scientific LLM / PDE-CLIP)',
      content:
        'Nghiên cứu tích hợp mô hình ngôn ngữ lớn để tự động tạo lưới tính toán (mesh generation) và sinh tham số vật lý ban đầu từ văn bản kỹ thuật.',
      columnId: fluxStateMap.get('Backlog')!,
      priority: WorkItemPriority.medium,
      rank: 2000,
      labels: [labelMap.get('Core AI / Deep Learning')!],
      authorId: ownerUser.id,
      assigneeId: postDocUser.id,
      assigneeIds: [postDocUser.id],
      projectId: fluxProject.id,
      completed: false,
    },
  });
  await assignLabel(w2.id, 'Core AI / Deep Learning');
  await assignUser(w2.id, postDocUser.id, true);

  const w3 = await prisma.workItem.create({
    data: {
      sequenceNumber: 3,
      identifier: 'FLUX-3',
      title:
        'Đề xuất nâng cấp cụm máy chủ: Mua sắm 8x NVIDIA H100 SXM5 qua kết nối NVLink 900GB/s',
      content:
        'Lập bảng báo giá và tờ trình gửi Ban Giám hiệu Viện nghiên cứu. Đảm bảo nguồn điện 3 pha và hệ thống làm mát chất lỏng cho phòng server Lab.',
      columnId: fluxStateMap.get('Backlog')!,
      priority: WorkItemPriority.high,
      rank: 3000,
      labels: [
        labelMap.get('GPU Cluster & HPC')!,
        labelMap.get('Lab Operations')!,
      ],
      authorId: ownerUser.id,
      assigneeId: raUser.id,
      assigneeIds: [raUser.id, ownerUser.id],
      projectId: fluxProject.id,
      completed: false,
    },
  });
  await assignLabel(w3.id, 'GPU Cluster & HPC');
  await assignLabel(w3.id, 'Lab Operations');
  await assignUser(w3.id, raUser.id, true);

  // ── TO DO ───────────────────────────────────────────────────────────────
  const w4 = await prisma.workItem.create({
    data: {
      sequenceNumber: 4,
      identifier: 'FLUX-4',
      title:
        'Phỏng vấn và tuyển chọn 2 Nghiên cứu sinh (Ph.D. Fellowships) mùa Thu 2026',
      content:
        'Hội đồng phỏng vấn gồm GS. TS. Ngô Tấn Thành (Chủ tịch) và Dr. Evelyn Vance. Tiêu chí: có nền tảng Toán giải tích xuất sắc, thành thạo PyTorch và C++/CUDA.',
      columnId: fluxStateMap.get('To Do')!,
      priority: WorkItemPriority.high,
      rank: 1000,
      labels: [labelMap.get('Lab Operations')!],
      startDate: new Date(now.getTime() + 1 * dayMs),
      dueDate: new Date(now.getTime() + 6 * dayMs),
      authorId: ownerUser.id,
      assigneeId: ownerUser.id,
      assigneeIds: [ownerUser.id, coPiUser.id],
      projectId: fluxProject.id,
      completed: false,
    },
  });
  await assignLabel(w4.id, 'Lab Operations');
  await assignUser(w4.id, ownerUser.id, true);
  await assignUser(w4.id, coPiUser.id, false);

  const w5 = await prisma.workItem.create({
    data: {
      sequenceNumber: 5,
      identifier: 'FLUX-5',
      title:
        'Đồng bộ 45 bài báo trích dẫn mới từ Zotero Shared Collection vào thư viện Lab',
      content:
        'Tổng hợp các công trình Neural Operator mới nhất tại NeurIPS 2025 và ICLR 2026. Kiểm tra chuẩn BibTeX và sinh khóa trích dẫn chuẩn cho cả Lab.',
      columnId: fluxStateMap.get('To Do')!,
      priority: WorkItemPriority.medium,
      rank: 2000,
      labels: [
        labelMap.get('BibTeX & Zotero')!,
        labelMap.get('LaTeX Manuscript')!,
      ],
      dueDate: new Date(now.getTime() + 3 * dayMs),
      authorId: ownerUser.id,
      assigneeId: phdUser.id,
      assigneeIds: [phdUser.id],
      projectId: fluxProject.id,
      completed: false,
    },
  });
  await assignLabel(w5.id, 'BibTeX & Zotero');
  await assignLabel(w5.id, 'LaTeX Manuscript');
  await assignUser(w5.id, phdUser.id, true);

  const w6 = await prisma.workItem.create({
    data: {
      sequenceNumber: 6,
      identifier: 'FLUX-6',
      title:
        'Cấu hình Slurm Multi-node DDP trên 4 node A100 SXM4 80GB cho huấn luyện song song',
      content:
        'Tối ưu hóa các cờ NCCL_DEBUG=INFO, NCCL_IB_DISABLE=0 trên mạng InfiniBand 200Gbps để đạt 94% hiệu suất mở rộng tuyến tính.',
      columnId: fluxStateMap.get('To Do')!,
      priority: WorkItemPriority.urgent,
      rank: 3000,
      labels: [labelMap.get('GPU Cluster & HPC')!],
      startDate: new Date(now.getTime() + 2 * dayMs),
      dueDate: new Date(now.getTime() + 5 * dayMs),
      authorId: ownerUser.id,
      assigneeId: raUser.id,
      assigneeIds: [raUser.id, postDocUser.id],
      projectId: fluxProject.id,
      completed: false,
    },
  });
  await assignLabel(w6.id, 'GPU Cluster & HPC');
  await assignUser(w6.id, raUser.id, true);
  await assignUser(w6.id, postDocUser.id, false);

  // ── IN PROGRESS ─────────────────────────────────────────────────────────
  const w7 = await prisma.workItem.create({
    data: {
      sequenceNumber: 7,
      identifier: 'FLUX-7',
      title:
        '[Nghiên cứu Trọng Điểm] Đạo hàm và tích hợp hàm mất mát H1 Sobolev vào Neural Operator',
      content:
        'Bảo toàn độ xoáy (vorticity conservation) trong phương trình Navier-Stokes 2D/3D. Trực tiếp chỉ đạo và kiểm tra chứng minh toán học: GS. TS. Ngô Tấn Thành.',
      columnId: fluxStateMap.get('In Progress')!,
      priority: WorkItemPriority.urgent,
      rank: 1000,
      labels: [
        labelMap.get('Core AI / Deep Learning')!,
        labelMap.get('Fluid Mechanics')!,
      ],
      startDate: new Date(now.getTime() - 3 * dayMs),
      dueDate: new Date(now.getTime() + 2 * dayMs),
      authorId: ownerUser.id,
      assigneeId: ownerUser.id,
      assigneeIds: [ownerUser.id, coPiUser.id],
      projectId: fluxProject.id,
      completed: false,
    },
  });
  await assignLabel(w7.id, 'Core AI / Deep Learning');
  await assignLabel(w7.id, 'Fluid Mechanics');
  await assignUser(w7.id, ownerUser.id, true);
  await assignUser(w7.id, coPiUser.id, false);

  // Sub-items for FLUX-7
  await prisma.workItem.create({
    data: {
      sequenceNumber: 16,
      identifier: 'FLUX-16',
      title:
        'Thiết lập toán tử vi phân sai phân hữu hạn bảo toàn miền biên Dirichlet',
      columnId: fluxStateMap.get('Completed')!,
      priority: WorkItemPriority.high,
      rank: 100,
      authorId: ownerUser.id,
      assigneeId: ownerUser.id,
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
        'Viết module PyTorch Custom Autograd Loss hỗ trợ vector hóa GPU tensor',
      columnId: fluxStateMap.get('Completed')!,
      priority: WorkItemPriority.urgent,
      rank: 200,
      authorId: ownerUser.id,
      assigneeId: postDocUser.id,
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
        'Kiểm chứng thực nghiệm trên xoáy Taylor-Green vortex ở số Reynolds Re=5,000',
      columnId: fluxStateMap.get('In Progress')!,
      priority: WorkItemPriority.urgent,
      rank: 300,
      authorId: ownerUser.id,
      assigneeId: ownerUser.id,
      parentWorkItemId: w7.id,
      projectId: fluxProject.id,
      completed: false,
    },
  });

  // Comments for FLUX-7
  await prisma.workItemComment.create({
    data: {
      workItemId: w7.id,
      authorId: ownerUser.id,
      content:
        'Hàm phạt Sobolev norm cấp 1 giúp triệt tiêu hoàn toàn hiện tượng nhiễu phổ tần số cao gần lớp biên. Kết quả mô phỏng ban đầu rất khả quan.',
    },
  });
  await prisma.workItemComment.create({
    data: {
      workItemId: w7.id,
      authorId: coPiUser.id,
      content:
        'Đã đối soát với mã nguồn DNS Nek5000: sai số L2 giảm từ 4.8% xuống còn 0.72%, tốc độ suy luận nhanh gấp 850 lần solver truyền thống.',
    },
  });

  const w8 = await prisma.workItem.create({
    data: {
      sequenceNumber: 8,
      identifier: 'FLUX-8',
      title:
        'Soạn thảo Section 3 (Methodology & Mathematical Proofs) trong main.tex của Lab',
      content:
        'Xây dựng các định lý về tính hội tụ đều của toán tử Fourier phi tuyến trong không gian Hilbert. Chèn hình vẽ kiến trúc TikZ chuẩn bị gửi JFM.',
      columnId: fluxStateMap.get('In Progress')!,
      priority: WorkItemPriority.high,
      rank: 2000,
      labels: [labelMap.get('LaTeX Manuscript')!],
      startDate: new Date(now.getTime() - 2 * dayMs),
      dueDate: new Date(now.getTime() + 4 * dayMs),
      authorId: ownerUser.id,
      assigneeId: coPiUser.id,
      assigneeIds: [coPiUser.id, ownerUser.id],
      projectId: fluxProject.id,
      completed: false,
    },
  });
  await assignLabel(w8.id, 'LaTeX Manuscript');
  await assignUser(w8.id, coPiUser.id, true);
  await assignUser(w8.id, ownerUser.id, false);

  // Sub-items for FLUX-8
  await prisma.workItem.create({
    data: {
      sequenceNumber: 19,
      identifier: 'FLUX-19',
      title:
        'Chứng minh định lý xấp xỉ phổ phổ quát (Universal Approximation Theorem for FNO)',
      columnId: fluxStateMap.get('Completed')!,
      priority: WorkItemPriority.urgent,
      rank: 100,
      authorId: ownerUser.id,
      assigneeId: coPiUser.id,
      parentWorkItemId: w8.id,
      projectId: fluxProject.id,
      completed: true,
    },
  });

  await prisma.workItem.create({
    data: {
      sequenceNumber: 20,
      identifier: 'FLUX-20',
      title:
        'Vẽ sơ đồ luồng kiến trúc mạng Fourier Neural Operator bằng gói LaTeX TikZ',
      columnId: fluxStateMap.get('In Progress')!,
      priority: WorkItemPriority.medium,
      rank: 200,
      authorId: ownerUser.id,
      assigneeId: phdUser.id,
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
        'Tối ưu hóa bộ nhớ GPU bằng kỹ thuật FlashAttention và Fused Fourier Kernels',
      content:
        'Giảm tiêu hao VRAM từ 72GB xuống 36GB để có thể chạy kích thước batch size 64 trực tiếp trên các card A100 của phòng thí nghiệm.',
      columnId: fluxStateMap.get('In Progress')!,
      priority: WorkItemPriority.high,
      rank: 3000,
      labels: [
        labelMap.get('Core AI / Deep Learning')!,
        labelMap.get('GPU Cluster & HPC')!,
      ],
      startDate: new Date(now.getTime() - 4 * dayMs),
      dueDate: new Date(now.getTime() + 1 * dayMs),
      authorId: ownerUser.id,
      assigneeId: postDocUser.id,
      assigneeIds: [postDocUser.id],
      projectId: fluxProject.id,
      completed: false,
    },
  });
  await assignLabel(w9.id, 'Core AI / Deep Learning');
  await assignLabel(w9.id, 'GPU Cluster & HPC');
  await assignUser(w9.id, postDocUser.id, true);

  // ── UNDER REVIEW ────────────────────────────────────────────────────────
  const w10 = await prisma.workItem.create({
    data: {
      sequenceNumber: 10,
      identifier: 'FLUX-10',
      title:
        '[Phản biện Quốc tế] Thẩm định kết quả benchmark dòng chảy rối Taylor-Green Re=1600-5000',
      content:
        'Hội đồng phản biện do GS. Marcus Brody chủ trì xem xét dữ liệu phổ tiêu tán năng lượng động học (kinetic energy dissipation rate) so với Nek5000.',
      columnId: fluxStateMap.get('Under Review')!,
      priority: WorkItemPriority.urgent,
      rank: 1000,
      labels: [labelMap.get('Peer Review')!, labelMap.get('Fluid Mechanics')!],
      dueDate: new Date(now.getTime() + 2 * dayMs),
      authorId: ownerUser.id,
      assigneeId: ownerUser.id,
      assigneeIds: [ownerUser.id, reviewerUser.id],
      projectId: fluxProject.id,
      completed: false,
    },
  });
  await assignLabel(w10.id, 'Peer Review');
  await assignLabel(w10.id, 'Fluid Mechanics');
  await assignUser(w10.id, ownerUser.id, true);
  await assignUser(w10.id, reviewerUser.id, false);

  await prisma.workItemComment.create({
    data: {
      workItemId: w10.id,
      authorId: reviewerUser.id,
      content:
        'Đường cong tiêu tán năng lượng trùng khớp với dữ liệu phổ Nek5000 với sai số dưới 1.4%. Đề nghị GS. Tấn Thành và nhóm nghiên cứu bổ sung biểu đồ enstrophy trước khi ký nghiệm thu chính thức.',
    },
  });

  const w11 = await prisma.workItem.create({
    data: {
      sequenceNumber: 11,
      identifier: 'FLUX-11',
      title:
        'Họp phản hồi ý kiến phản biện (Rebuttal Meeting) cho bài báo gửi Journal of Fluid Mechanics',
      content:
        'Thống nhất câu trả lời cho 3 chuyên gia phản biện vòng 1. Bổ sung các thí nghiệm ngoại suy (Out-of-Distribution) theo yêu cầu của Reviewer 2.',
      columnId: fluxStateMap.get('Under Review')!,
      priority: WorkItemPriority.high,
      rank: 2000,
      labels: [labelMap.get('Peer Review')!, labelMap.get('LaTeX Manuscript')!],
      dueDate: new Date(now.getTime() + 1 * dayMs),
      authorId: ownerUser.id,
      assigneeId: coPiUser.id,
      assigneeIds: [coPiUser.id, ownerUser.id],
      projectId: fluxProject.id,
      completed: false,
    },
  });
  await assignLabel(w11.id, 'Peer Review');
  await assignLabel(w11.id, 'LaTeX Manuscript');
  await assignUser(w11.id, coPiUser.id, true);
  await assignUser(w11.id, ownerUser.id, false);

  // ── COMPLETED ───────────────────────────────────────────────────────────
  const w12 = await prisma.workItem.create({
    data: {
      sequenceNumber: 12,
      identifier: 'FLUX-12',
      title:
        'Xuất bản công khai bộ dữ liệu 2D Kolmogorov DNS 512x512 trên Zenodo & HuggingFace',
      content:
        'Bộ dữ liệu bao gồm 10,000 ảnh chụp trạng thái vận tốc và độ xoáy, được gắn DOI định danh quốc tế kèm tài liệu hướng dẫn chuẩn FAIR.',
      columnId: fluxStateMap.get('Completed')!,
      priority: WorkItemPriority.high,
      rank: 1000,
      labels: [
        labelMap.get('Fluid Mechanics')!,
        labelMap.get('Lab Operations')!,
      ],
      startDate: new Date(now.getTime() - 14 * dayMs),
      dueDate: new Date(now.getTime() - 5 * dayMs),
      authorId: ownerUser.id,
      assigneeId: ownerUser.id,
      assigneeIds: [ownerUser.id],
      projectId: fluxProject.id,
      completed: true,
    },
  });
  await assignLabel(w12.id, 'Fluid Mechanics');
  await assignLabel(w12.id, 'Lab Operations');
  await assignUser(w12.id, ownerUser.id, true);

  const w13 = await prisma.workItem.create({
    data: {
      sequenceNumber: 13,
      identifier: 'FLUX-13',
      title:
        'Triển khai hạ tầng biên dịch LaTeX tích hợp Overleaf / CLSI nội bộ cho cả Lab',
      content:
        'Cài đặt thành công Docker microservices CLSI hỗ trợ biên dịch song song, tự động sửa lỗi tham chiếu chéo và xuất file PDF sắc nét.',
      columnId: fluxStateMap.get('Completed')!,
      priority: WorkItemPriority.urgent,
      rank: 2000,
      labels: [
        labelMap.get('GPU Cluster & HPC')!,
        labelMap.get('LaTeX Manuscript')!,
      ],
      startDate: new Date(now.getTime() - 10 * dayMs),
      dueDate: new Date(now.getTime() - 2 * dayMs),
      authorId: ownerUser.id,
      assigneeId: raUser.id,
      assigneeIds: [raUser.id],
      projectId: fluxProject.id,
      completed: true,
    },
  });
  await assignLabel(w13.id, 'GPU Cluster & HPC');
  await assignLabel(w13.id, 'LaTeX Manuscript');
  await assignUser(w13.id, raUser.id, true);

  const w14 = await prisma.workItem.create({
    data: {
      sequenceNumber: 14,
      identifier: 'FLUX-14',
      title:
        'Báo cáo nghiệm thu giai đoạn 1 đề tài nghiên cứu cấp Nhà Nước đạt loại Xuất Sắc',
      content:
        'Hội đồng khoa học đánh giá cao việc nhóm đã công bố 2 bài báo quốc tế Q1 và làm chủ công nghệ mô phỏng vật lý bằng mạng nơ-ron.',
      columnId: fluxStateMap.get('Completed')!,
      priority: WorkItemPriority.high,
      rank: 3000,
      labels: [labelMap.get('Grant & Funding')!],
      startDate: new Date(now.getTime() - 20 * dayMs),
      dueDate: new Date(now.getTime() - 7 * dayMs),
      authorId: ownerUser.id,
      assigneeId: ownerUser.id,
      assigneeIds: [ownerUser.id, coPiUser.id],
      projectId: fluxProject.id,
      completed: true,
    },
  });
  await assignLabel(w14.id, 'Grant & Funding');
  await assignUser(w14.id, ownerUser.id, true);
  await assignUser(w14.id, coPiUser.id, false);

  // ── CANCELLED ───────────────────────────────────────────────────────────
  const w15 = await prisma.workItem.create({
    data: {
      sequenceNumber: 15,
      identifier: 'FLUX-15',
      title:
        'Hủy hướng tiếp cận mạng MLP cổ điển (Fully Connected) cho phương trình dòng chảy',
      content:
        'Kết quả thực nghiệm chứng minh MLP hoàn toàn thất bại trong việc phân giải cấu trúc xoáy vi mô do giới hạn Spectral Bias. Chuyển toàn bộ tài nguyên sang Fourier Neural Operators.',
      columnId: fluxStateMap.get('Cancelled')!,
      priority: WorkItemPriority.low,
      rank: 1000,
      labels: [labelMap.get('Core AI / Deep Learning')!],
      authorId: ownerUser.id,
      projectId: fluxProject.id,
      completed: false,
    },
  });
  await assignLabel(w15.id, 'Core AI / Deep Learning');

  await prisma.project.update({
    where: { id: fluxProject.id },
    data: { workItemSequence: 21 },
  });

  // 8. Seed Lab Sticky Notes for GS. Tấn Thành
  await prisma.sticky.deleteMany({ where: { userId: ownerUser.id } });

  await prisma.sticky.create({
    data: {
      title: '📌 Lịch Giao Ban Lab & Hạn Chót',
      content:
        '• Họp Lab định kỳ: Thứ Năm hàng tuần lúc 09:30 AM (Phòng 402 & Zoom).\n• 15/10: Hạn chót nộp bản thảo NeurIPS Camera-Ready.\n• 28/10: Báo cáo tài chính & tiến độ đề tài NAFOSTED.\n• Lưu ý: Nhóm mô phỏng 3D gửi báo cáo trước 18h thứ Tư.',
      color: 'yellow-1',
      positionX: 30,
      positionY: 80,
      order: 0,
      userId: ownerUser.id,
    },
  });

  await prisma.sticky.create({
    data: {
      title: '⚡ Phân Bổ Cụm Siêu Máy Tính GPU',
      content:
        '• Node [A100-01, 02]: Ưu tiên độc quyền cho huấn luyện FNO 3D Navier-Stokes.\n• Node [A100-03]: Phục vụ kiểm thử suy luận & zero-shot mesh.\n• Node [A100-04]: Dành cho các thử nghiệm của nghiên cứu sinh.\n• Mọi job phải gửi qua Slurm script, tuyệt đối không chạy daemon ngoài.',
      color: 'cyan-1',
      positionX: 320,
      positionY: 80,
      order: 1,
      userId: ownerUser.id,
    },
  });

  await prisma.sticky.create({
    data: {
      title: '🤝 Tiếp Đón GS. Marcus Brody',
      content:
        '• Thứ Ba tới: Tiếp đón GS. Marcus Brody (Advisory Board).\n• 10h00: Tham quan cụm máy chủ và hệ thống đo kiểm.\n• 14h00: Seminar khoa học về phương pháp giải phương trình vi phân đa thang đo.\n• Phân công: Sarah Jenkins chuẩn bị tài liệu thuyết trình.',
      color: 'purple-1',
      positionX: 610,
      positionY: 80,
      order: 2,
      userId: ownerUser.id,
    },
  });

  console.log('📌 Seeded 3 official Lab Sticky Notes.');

  // 9. Update LaTeX Manuscript to reflect Lab & GS. Tấn Thành as Lead / Corresponding Author
  const existingDocs = await prisma.manuscriptDoc.findMany({
    where: { projectId: fluxProject.id },
  });
  if (existingDocs.length === 0) {
    console.log('📝 Seeding LaTeX research manuscript for Lab...');
    const demoFiles = getDemoBackendFiles('main');
    for (let idx = 0; idx < demoFiles.length; idx++) {
      const f = demoFiles[idx];
      let content = f.content;
      if (f.name === 'main.tex') {
        content = content.replace(
          '\\title{',
          '\\title{Physics-Informed Fourier Neural Operators for Multi-Scale Navier-Stokes Equations}\n\\author{Prof. Tan Thanh Ngo$^{1,*}$, Dr. Evelyn Vance$^1$, Alex Chen$^1$, Prof. Marcus Brody$^2$}\n\\affiliation{$^1$Flux Laboratory for Neural Computing and Scientific AI\\\\\n$^2$Department of Applied Mathematics and Theoretical Physics}\n\\thanks{*Corresponding author: ngotanthanh92.26@gmail.com (Lab Director)}\n%',
        );
      }
      const doc = await prisma.manuscriptDoc.create({
        data: {
          projectId: fluxProject.id,
          path: f.path,
          lines: content.split('\n'),
          sizeBytes: Buffer.byteLength(content, 'utf8'),
          rev: 1,
          version: 1,
        },
      });

      await prisma.manuscriptNode.create({
        data: {
          projectId: fluxProject.id,
          name: f.name,
          path: f.path,
          type: 'DOC',
          docId: doc.id,
          isRootDoc: f.name === 'main.tex',
          sizeBytes: Buffer.byteLength(content, 'utf8'),
          sortOrder: idx,
        },
      });
    }
    console.log(`   ✅ Seeded ${demoFiles.length} LaTeX files for Flux Lab.`);
  }

  // 10. Seed Lab Library Collections (Zotero papers)
  const existingCol = await prisma.collection.findFirst({
    where: { projectId: fluxProject.id },
  });
  if (!existingCol) {
    const col = await prisma.collection.create({
      data: {
        name: 'Tài Liệu Nghiên Cứu Mũi Nhọn (Lab Papers)',
        description:
          'Tập hợp các bài báo kinh điển và tiền ấn phẩm (Preprints) của phòng thí nghiệm Flux Lab.',
        color: '#3b82f6',
        icon: 'Atom',
        userId: ownerUser.id,
        projectId: fluxProject.id,
      },
    });

    const paper1 = await prisma.item.create({
      data: {
        title:
          'Fourier Neural Operator for Parametric Partial Differential Equations',
        itemType: 'journalArticle',
        year: 2021,
        citationKey: 'li2021fourier',
        doi: '10.48550/arXiv.2010.08895',
        publicationTitle:
          'International Conference on Learning Representations (ICLR)',
        abstract:
          'The classical neural network approaches for learning in PDEs learn continuous functions, which are mesh-dependent. We propose Fourier neural operator that directly learns the operator in infinite-dimensional spaces.',
        userId: ownerUser.id,
        projectId: fluxProject.id,
        firstAuthor: 'Li, Zongyi',
      },
    });

    const paper2 = await prisma.item.create({
      data: {
        title:
          'Physics-Informed Neural Networks: A Deep Learning Framework for Solving PDEs',
        itemType: 'journalArticle',
        year: 2019,
        citationKey: 'raissi2019physics',
        doi: '10.1016/j.jcp.2018.10.045',
        publicationTitle: 'Journal of Computational Physics',
        abstract:
          'We introduce physics-informed neural networks - neural networks that are trained to solve supervised learning tasks while respecting physical conservation laws described by nonlinear partial differential equations.',
        userId: ownerUser.id,
        projectId: fluxProject.id,
        firstAuthor: 'Raissi, Maziar',
      },
    });

    await prisma.collectionItem.createMany({
      data: [
        { collectionId: col.id, itemId: paper1.id },
        { collectionId: col.id, itemId: paper2.id },
      ],
    });
    console.log(
      '📚 Seeded Lab library collection and foundational research papers.',
    );
  }

  // 11. Invalidate Redis Caches
  try {
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    const keys = await redis.keys('*');
    const targetKeys = keys.filter(
      (k) =>
        k.includes('work-item') ||
        k.includes('flux:wi') ||
        k.includes('project') ||
        k.includes('user') ||
        k.includes('sticky'),
    );
    if (targetKeys.length > 0) {
      await redis.del(...targetKeys);
      console.log(`🧹 Flushed ${targetKeys.length} Redis cache keys.`);
    }
    await redis.quit();
  } catch (err) {
    console.warn('⚠️ Warning Redis flush:', err);
  }

  console.log('\n🏆 Lab simulation setup SUCCESSFUL!');
}

run()
  .catch((e) => {
    console.error('❌ Error creating lab simulation:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
