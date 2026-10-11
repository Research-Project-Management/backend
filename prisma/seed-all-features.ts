import 'dotenv/config';
import {
  PrismaClient,
  Role,
  WorkItemPriority,
  EntityType,
  MessageRole,
  IntegrationProvider,
  IntegrationStatus,
  ProjectPriority,
  ProjectUpdateStatus,
  FilePermission,
  ManuscriptChangeType,
  ManuscriptChangeStatus,
  ManuscriptNotificationType,
  ManuscriptTemplateCategory,
  AuditOutcome,
  AuditSeverity,
  ThemePreference,
} from '@prisma/client';
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

async function seedAllFeatures() {
  console.log('🚀 Starting end-to-end multi-feature seeding for Tấn Thành...');

  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  const minMs = 60 * 1000;

  // 1. Resolve User and Collaborators
  const userThanh = await prisma.user.findFirst({
    where: { email: 'ngotanthanh92.26@gmail.com' },
    include: { profile: true },
  });
  if (!userThanh) {
    throw new Error(
      'User ngotanthanh92.26@gmail.com not found. Please run base seed first.',
    );
  }

  const adminUser = await prisma.user.findFirst({
    where: { email: 'admin@rpm.local' },
  });
  const researcherUser = await prisma.user.findFirst({
    where: { email: 'researcher@rpm.local' },
  });
  const reviewerUser = await prisma.user.findFirst({
    where: { email: 'reviewer@rpm.local' },
  });

  if (!adminUser || !researcherUser || !reviewerUser) {
    throw new Error(
      'Collaborator users not found. Please run base seed first.',
    );
  }

  console.log(`👤 Primary user: ${userThanh.email} (${userThanh.id})`);

  // ============================================================================
  // 1. USER PROFILE, SETTINGS & USER ACCOUNTS
  // ============================================================================
  console.log(
    '👤 [1/9] Enriching User Profile, Settings, and OAuth Account...',
  );
  await prisma.userProfile.upsert({
    where: { userId: userThanh.id },
    create: {
      userId: userThanh.id,
      name: 'Tấn Thành',
      avatar:
        'https://lh3.googleusercontent.com/a/ACg8ocLfL42lSWtqIwZdRz8r9d64G5dfKsAaMJ8SvRMLcWSckzM5KbY=s96-c',
      institution: 'Viện Công nghệ Thông tin & Trí tuệ Nhân tạo - ĐHQG Hà Nội',
    },
    update: {
      name: 'Tấn Thành',
      avatar:
        'https://lh3.googleusercontent.com/a/ACg8ocLfL42lSWtqIwZdRz8r9d64G5dfKsAaMJ8SvRMLcWSckzM5KbY=s96-c',
      institution: 'Viện Công nghệ Thông tin & Trí tuệ Nhân tạo - ĐHQG Hà Nội',
    },
  });

  await prisma.userSettings.upsert({
    where: { userId: userThanh.id },
    create: {
      userId: userThanh.id,
      theme: ThemePreference.system,
      locale: 'vi',
      editorConfig: {
        fontSize: 14,
        fontFamily: 'Fira Code',
        tabSize: 2,
        lineNumbers: true,
        wordWrap: true,
        autoCompile: true,
        keybinding: 'standard',
        minimap: true,
        renderWhitespace: 'selection',
      },
    },
    update: {
      theme: ThemePreference.system,
      locale: 'vi',
      editorConfig: {
        fontSize: 14,
        fontFamily: 'Fira Code',
        tabSize: 2,
        lineNumbers: true,
        wordWrap: true,
        autoCompile: true,
        keybinding: 'standard',
        minimap: true,
        renderWhitespace: 'selection',
      },
    },
  });

  // Ensure Google OAuth UserAccount exists
  const existingGoogleAccount = await prisma.userAccount.findFirst({
    where: { userId: userThanh.id, provider: 'google' },
  });
  if (!existingGoogleAccount) {
    await prisma.userAccount.create({
      data: {
        userId: userThanh.id,
        provider: 'google',
        providerSubjectId: 'google-oauth2|114820194820194',
        email: userThanh.email,
        profileData: {
          name: 'Tấn Thành',
          email: userThanh.email,
          picture:
            'https://lh3.googleusercontent.com/a/ACg8ocLfL42lSWtqIwZdRz8r9d64G5dfKsAaMJ8SvRMLcWSckzM5KbY=s96-c',
          verified_email: true,
        },
      },
    });
  }

  // ============================================================================
  // 2. PROJECTS, FAVORITES, UPDATES & LABELS
  // ============================================================================
  console.log(
    '📁 [2/9] Seeding Multi-Project Ecosystem, Favorites, and Status Updates...',
  );

  // Primary project: flux
  let projectFlux = await prisma.project.findFirst({
    where: { identifier: 'FLUX' },
  });
  if (!projectFlux) {
    throw new Error('Project "FLUX" not found. Please run base seed first.');
  }

  await prisma.project.update({
    where: { id: projectFlux.id },
    data: {
      priority: ProjectPriority.high,
      startDate: new Date(now.getTime() - 60 * dayMs),
      targetDate: new Date(now.getTime() + 120 * dayMs),
    },
  });

  // Secondary project: NEURAL-PDE
  let projectNpde = await prisma.project.findFirst({
    where: { identifier: 'NPDE' },
  });
  if (!projectNpde) {
    projectNpde = await prisma.project.create({
      data: {
        name: 'Mô hình Toán tử Sâu & PINNs Đa Pha',
        identifier: 'NPDE',
        description:
          'Học toán tử sâu (Deep Operator Learning: Fourier Neural Operators & PINNs) giải bài toán dòng chảy nhiều pha và phương trình Navier-Stokes phi tuyến trên cụm tính toán hiệu năng cao.',
        createdById: userThanh.id,
        priority: ProjectPriority.medium,
        startDate: new Date(now.getTime() - 30 * dayMs),
        targetDate: new Date(now.getTime() + 180 * dayMs),
        members: {
          create: [
            { userId: userThanh.id, role: Role.owner },
            { userId: researcherUser.id, role: Role.contributor },
            { userId: adminUser.id, role: Role.contributor },
            { userId: reviewerUser.id, role: Role.reviewer },
          ],
        },
      },
    });
  }

  // Tertiary project: QUANTUM-OPT (Archived completed research)
  let projectQopt = await prisma.project.findFirst({
    where: { identifier: 'QOPT' },
  });
  if (!projectQopt) {
    projectQopt = await prisma.project.create({
      data: {
        name: 'Tối ưu hóa Mạch Lượng tử (Quantum Circuit Optimization)',
        identifier: 'QOPT',
        description:
          'Nghiên cứu bề mặt hàm mất mát phi lồi trong thuật toán VQE (Variational Quantum Eigensolver) và khử hiện tượng Barren Plateaus.',
        createdById: userThanh.id,
        priority: ProjectPriority.low,
        isArchived: true,
        archivedAt: new Date(now.getTime() - 45 * dayMs),
        startDate: new Date(now.getTime() - 200 * dayMs),
        targetDate: new Date(now.getTime() - 50 * dayMs),
        members: {
          create: [
            { userId: userThanh.id, role: Role.owner },
            { userId: reviewerUser.id, role: Role.reviewer },
          ],
        },
      },
    });
  }

  // Project Favorites
  await prisma.projectFavorite.deleteMany({ where: { userId: userThanh.id } });
  await prisma.projectFavorite.createMany({
    data: [
      { projectId: projectFlux.id, userId: userThanh.id },
      { projectId: projectNpde.id, userId: userThanh.id },
    ],
    skipDuplicates: true,
  });

  // Project Status Updates (Weekly summaries)
  await prisma.projectUpdate.deleteMany({
    where: { projectId: { in: [projectFlux.id, projectNpde.id] } },
  });
  await prisma.projectUpdate.createMany({
    data: [
      {
        projectId: projectFlux.id,
        status: ProjectUpdateStatus.on_track,
        message:
          'Đã hoàn thiện bản thảo ICLR 2026 với 10 mục chính và 4 phụ lục toán học. Phân tích hội tụ của thuật toán AdamW và bổ sung 45 tài liệu tham khảo chất lượng cao.',
        createdById: userThanh.id,
        createdAt: new Date(now.getTime() - 1 * dayMs),
      },
      {
        projectId: projectFlux.id,
        status: ProjectUpdateStatus.on_track,
        message:
          'Triển khai thử nghiệm FlashAttention-2 trên cụm 8x H100 SXM5, tốc độ xử lý đạt 3,450 tokens/giây/GPU (tăng tốc 2.4x so với PyTorch SDPA tiêu chuẩn).',
        createdById: researcherUser.id,
        createdAt: new Date(now.getTime() - 7 * dayMs),
      },
      {
        projectId: projectFlux.id,
        status: ProjectUpdateStatus.at_risk,
        message:
          'Cụm tính toán GPU A100 đang gặp tình trạng xếp hàng quá tải (Slurm queue delay), tạm thời phân bổ lại toàn bộ tác vụ huấn luyện sang các node H100 để đảm bảo tiến độ.',
        createdById: userThanh.id,
        createdAt: new Date(now.getTime() - 14 * dayMs),
      },
      {
        projectId: projectNpde.id,
        status: ProjectUpdateStatus.on_track,
        message:
          'Đã huấn luyện thành công mô hình Fourier Neural Operator 2D trên lưới 1024x1024 với sai số tương đối L2 đạt mức lý tưởng < 1.15%.',
        createdById: userThanh.id,
        createdAt: new Date(now.getTime() - 4 * dayMs),
      },
    ],
  });

  // Global & Project Labels
  const labelNames = [
    {
      name: 'Q1-Publication',
      color: '#10B981',
      desc: 'Bài báo nhắm tới tạp chí hạng Q1 / Hội nghị hàng đầu A*',
    },
    {
      name: 'Grant-Funded',
      color: '#F59E0B',
      desc: 'Đề tài được tài trợ bởi Quỹ Phát triển Khoa học Công nghệ Quốc gia',
    },
    {
      name: 'High-Impact',
      color: '#EF4444',
      desc: 'Đóng góp lý thuyết mang tính đột phá và ứng dụng rộng',
    },
    {
      name: 'Deep-Learning',
      color: '#3B82F6',
      desc: 'Kiến trúc Transformer và Học sâu',
    },
    {
      name: 'LaTeX-Manuscript',
      color: '#8B5CF6',
      desc: 'Bản thảo bài báo và kỷ yếu khoa học',
    },
  ];

  for (const lb of labelNames) {
    const createdLabel = await prisma.label.upsert({
      where: {
        userId_name: {
          userId: userThanh.id,
          name: lb.name,
        },
      },
      create: {
        name: lb.name,
        color: lb.color,
        description: lb.desc,
        userId: userThanh.id,
      },
      update: {
        color: lb.color,
        description: lb.desc,
      },
    });

    await prisma.projectLabel.upsert({
      where: {
        projectId_labelId: {
          projectId: projectFlux.id,
          labelId: createdLabel.id,
        },
      },
      create: {
        projectId: projectFlux.id,
        labelId: createdLabel.id,
        assignedById: userThanh.id,
      },
      update: {},
    });
  }

  // ============================================================================
  // 3. WORK ITEMS: COMMENTS, DRAFTS & ENTITY LINKS
  // ============================================================================
  console.log(
    '💬 [3/9] Adding Collaborative Discussions, Drafts, and Entity Links to Work Items...',
  );

  const workItems = await prisma.workItem.findMany({
    where: { projectId: projectFlux.id },
    select: { id: true, sequenceNumber: true, title: true },
  });
  const workItemsBySeq = new Map(
    workItems.map((w) => [w.sequenceNumber, w.id]),
  );

  // Work item comments on key tasks
  const commentsToSeed = [
    {
      seq: 12,
      author: userThanh.id,
      content:
        'Đã kiểm tra profiling bộ nhớ SRAM: Khi tích hợp FlashAttention-2, kích thước IO giữa HBM và SRAM giảm 4.2 lần, cho phép nâng context length lên 32,768 tokens mà không bị OOM.',
      timeAgoDays: 3,
    },
    {
      seq: 12,
      author: researcherUser.id,
      content:
        'Tôi đã cập nhật script benchmark.py để so sánh độ trễ giữa Triton kernel và CUDA C++ native kernel trên kiến trúc Hopper SXM5.',
      timeAgoDays: 2,
    },
    {
      seq: 14,
      author: adminUser.id,
      content:
        'Đề xuất bổ sung các macro chuẩn cho toán tử kỳ vọng: `\\E`, phân kỳ KL: `\\KL(\\cdot\\parallel\\cdot)`, và chuẩn ma trận Schatten: `\\|\\cdot\\|_{S_p}`.',
      timeAgoDays: 5,
    },
    {
      seq: 14,
      author: userThanh.id,
      content:
        'Hoàn toàn nhất trí. Đã cập nhật file `macros/math_commands.tex` đồng bộ với ký hiệu quy ước của tạp chí JMLR.',
      timeAgoDays: 4,
    },
    {
      seq: 20,
      author: reviewerUser.id,
      content:
        'Chất lượng hình ảnh trong Figure 4 (loss landscapes) cần xuất ra định dạng Vector PDF với độ phân giải tối thiểu 600 DPI để đạt tiêu chuẩn in ấn camera-ready.',
      timeAgoDays: 6,
    },
    {
      seq: 20,
      author: userThanh.id,
      content:
        'Đã tạo lại Figure 4 bằng script matplotlib pgf vector và kiểm tra biên dịch pdflatex hoàn toàn sắc nét.',
      timeAgoDays: 5,
    },
    {
      seq: 22,
      author: researcherUser.id,
      content:
        'Script Slurm đã kiểm tra chạy mượt trên cụm 8 node (64 GPU H100). Cờ giao tiếp NCCL `NCCL_IB_DISABLE=0` và `NCCL_P2P_DISABLE=0` đã được bật.',
      timeAgoDays: 8,
    },
    {
      seq: 32,
      author: userThanh.id,
      content:
        'Baseline ResNet-50 trên ImageNet-1K đạt top-1 accuracy 76.84% với cosine learning rate annealing và AdamW trong 100 epochs.',
      timeAgoDays: 10,
    },
  ];

  for (const c of commentsToSeed) {
    const wiId = workItemsBySeq.get(c.seq);
    if (wiId) {
      await prisma.workItemComment.create({
        data: {
          workItemId: wiId,
          authorId: c.author,
          content: c.content,
          createdAt: new Date(now.getTime() - c.timeAgoDays * dayMs),
        },
      });
    }
  }

  // Work Item Drafts for userThanh
  await prisma.workItemDraft.deleteMany({ where: { authorId: userThanh.id } });
  await prisma.workItemDraft.createMany({
    data: [
      {
        title:
          'Tối ưu hóa bộ nhớ SRAM cho FlashAttention-3 trên kiến trúc NVIDIA Hopper H100',
        content:
          'Khảo sát cơ chế Asynchronous Transaction Barrier và Tensor Memory Accelerator (TMA) để đạt 75% peak FP16 TFLOPs.',
        description:
          'Triển khai thử nghiệm chia tile $128 \\times 128$ và giảm triệt để số lượng thanh ghi bị tràn (register spill).',
        priority: WorkItemPriority.urgent,
        labels: ['Optimization', 'GPU Cluster & HPC'],
        projectId: projectFlux.id,
        authorId: userThanh.id,
        createdAt: new Date(now.getTime() - 2 * hourMs),
      },
      {
        title:
          'Khảo sát hàm tổn thất Wasserstein trong không gian Sobolev cho mô hình PINNs',
        content:
          'Nghiên cứu metric Wasserstein-1 để bắt chính xác các sóng kích kích động (shock waves) trong phương trình Burgers 1D phi tuyến.',
        description:
          'So sánh sai số tương đối L2 giữa hàm tổn thất MSE truyền thống và hàm tổn thất thích ứng theo gradient chuẩn.',
        priority: WorkItemPriority.medium,
        labels: ['Deep Learning', 'Scientific ML & Neural Operators'],
        projectId: projectNpde.id,
        authorId: userThanh.id,
        createdAt: new Date(now.getTime() - 8 * hourMs),
      },
      {
        title:
          'Bản thảo phản biện (Rebuttal) cho Reviewer #2 về tính ổn định của phân rã Cholesky',
        content:
          'Giải trình chi tiết về việc thêm hằng số làm mịn $\\epsilon = 10^{-8}$ vào ma trận hiệp phương sai để ngăn chặn suy biến ma trận khả nghịch.',
        description:
          'Cung cấp bảng thử nghiệm số học với số điều kiện (condition number) của ma trận trong 10,000 bước huấn luyện.',
        priority: WorkItemPriority.high,
        labels: ['Peer Review', 'Optimization'],
        projectId: projectFlux.id,
        authorId: userThanh.id,
        createdAt: new Date(now.getTime() - 24 * hourMs),
      },
    ],
  });

  // Work Item Entity Links (Linking WorkItems to Library Items & Storage Files)
  const flashAttentionItem = await prisma.item.findFirst({
    where: { title: { contains: 'FlashAttention' } },
  });
  const adamItem = await prisma.item.findFirst({
    where: {
      title: { contains: 'Adam: A Method for Stochastic Optimization' },
    },
  });
  const resnetItem = await prisma.item.findFirst({
    where: { title: { contains: 'Deep Residual Learning' } },
  });

  if (flashAttentionItem && workItemsBySeq.get(12)) {
    await prisma.workItemEntityLink.upsert({
      where: {
        workItemId_entityType_entityId: {
          workItemId: workItemsBySeq.get(12)!,
          entityType: EntityType.paper,
          entityId: flashAttentionItem.id,
        },
      },
      create: {
        workItemId: workItemsBySeq.get(12)!,
        entityType: EntityType.paper,
        entityId: flashAttentionItem.id,
        description:
          'Tài liệu tham khảo nền tảng cho việc triển khai FlashAttention-2',
      },
      update: {},
    });
  }

  if (adamItem && workItemsBySeq.get(19)) {
    await prisma.workItemEntityLink.upsert({
      where: {
        workItemId_entityType_entityId: {
          workItemId: workItemsBySeq.get(19)!,
          entityType: EntityType.paper,
          entityId: adamItem.id,
        },
      },
      create: {
        workItemId: workItemsBySeq.get(19)!,
        entityType: EntityType.paper,
        entityId: adamItem.id,
        description:
          'Bài báo gốc về thuật toán Adam để đối chiếu định lý hội tụ',
      },
      update: {},
    });
  }

  if (resnetItem && workItemsBySeq.get(32)) {
    await prisma.workItemEntityLink.upsert({
      where: {
        workItemId_entityType_entityId: {
          workItemId: workItemsBySeq.get(32)!,
          entityType: EntityType.paper,
          entityId: resnetItem.id,
        },
      },
      create: {
        workItemId: workItemsBySeq.get(32)!,
        entityType: EntityType.paper,
        entityId: resnetItem.id,
        description: 'Kiến trúc mạng nơ-ron tích chập dùng làm chuẩn đối chuẩn',
      },
      update: {},
    });
  }

  // ============================================================================
  // 4. ENTERPRISE STORAGE & DRIVE (FILES, FOLDERS, VERSIONS, SHARES)
  // ============================================================================
  console.log(
    '💾 [4/9] Seeding Personal & Project Cloud Drive Storage, Folders & File Versions...',
  );

  // Clean previous storage files for user
  await prisma.fileShare.deleteMany({
    where: { file: { authorId: userThanh.id } },
  });
  await prisma.fileVersion.deleteMany({
    where: { file: { authorId: userThanh.id } },
  });
  await prisma.file.deleteMany({
    where: { authorId: userThanh.id },
  });

  // Personal Drive Folders
  const folderDatasets = await prisma.file.create({
    data: {
      filename: 'Datasets & Benchmarks',
      isFolder: true,
      linkedToType: 'personal',
      linkedToId: userThanh.id,
      authorId: userThanh.id,
      starred: true,
    },
  });

  const folderCheckpoints = await prisma.file.create({
    data: {
      filename: 'Model Checkpoints & Weights',
      isFolder: true,
      linkedToType: 'personal',
      linkedToId: userThanh.id,
      authorId: userThanh.id,
      starred: false,
    },
  });

  const folderPresentations = await prisma.file.create({
    data: {
      filename: 'Manuscripts & Slides',
      isFolder: true,
      linkedToType: 'personal',
      linkedToId: userThanh.id,
      authorId: userThanh.id,
      starred: true,
    },
  });

  const folderPlots = await prisma.file.create({
    data: {
      filename: 'Visualizations & Plots',
      isFolder: true,
      linkedToType: 'personal',
      linkedToId: userThanh.id,
      authorId: userThanh.id,
      starred: false,
    },
  });

  // Files inside Datasets folder
  await prisma.file.createMany({
    data: [
      {
        filename: 'cifar100-h100-features-resnet50.arrow',
        size: BigInt(134217728), // 128 MB
        mimeType: 'application/octet-stream',
        url: 'https://storage.rpm.local/datasets/cifar100-h100-features-resnet50.arrow',
        parentId: folderDatasets.id,
        linkedToType: 'personal',
        linkedToId: userThanh.id,
        authorId: userThanh.id,
        starred: false,
        metaData: { rows: 50000, dimensions: 2048, format: 'Apache Arrow IPC' },
      },
      {
        filename: 'burgers-shock-pde-1024grid.h5',
        size: BigInt(440401920), // 420 MB
        mimeType: 'application/x-hdf5',
        url: 'https://storage.rpm.local/datasets/burgers-shock-pde-1024grid.h5',
        parentId: folderDatasets.id,
        linkedToType: 'personal',
        linkedToId: userThanh.id,
        authorId: userThanh.id,
        starred: true,
        metaData: {
          gridResolution: '1024x1024',
          viscosity: 0.01,
          timesteps: 200,
        },
      },
      {
        filename: 'imagenet1k-val-accuracy-metrics.csv',
        size: BigInt(15728640), // 15 MB
        mimeType: 'text/csv',
        url: 'https://storage.rpm.local/datasets/imagenet1k-val-accuracy-metrics.csv',
        parentId: folderDatasets.id,
        linkedToType: 'personal',
        linkedToId: userThanh.id,
        authorId: userThanh.id,
        starred: false,
      },
    ],
  });

  // Files inside Model Checkpoints folder
  const fileCheckpoint = await prisma.file.create({
    data: {
      filename: 'flux-adamw-h100-epoch50.pt',
      size: BigInt(1503238553), // 1.4 GB
      mimeType: 'application/octet-stream',
      url: 'https://storage.rpm.local/models/flux-adamw-h100-epoch50.pt',
      parentId: folderCheckpoints.id,
      linkedToType: 'personal',
      linkedToId: userThanh.id,
      authorId: userThanh.id,
      starred: true,
      metaData: {
        architecture: 'ViT-Huge/14',
        epoch: 50,
        validationLoss: 0.842,
      },
    },
  });

  await prisma.file.create({
    data: {
      filename: 'lora-adapter-llama3-8b-r16.safetensors',
      size: BigInt(67108864), // 64 MB
      mimeType: 'application/octet-stream',
      url: 'https://storage.rpm.local/models/lora-adapter-llama3-8b-r16.safetensors',
      parentId: folderCheckpoints.id,
      linkedToType: 'personal',
      linkedToId: userThanh.id,
      authorId: userThanh.id,
      starred: false,
    },
  });

  // Files inside Presentations folder
  const fileSlides = await prisma.file.create({
    data: {
      filename: 'ICLR2026-Oral-Presentation-Slides.pdf',
      size: BigInt(18874368), // 18 MB
      mimeType: 'application/pdf',
      url: 'https://storage.rpm.local/papers/ICLR2026-Oral-Presentation-Slides.pdf',
      parentId: folderPresentations.id,
      linkedToType: 'personal',
      linkedToId: userThanh.id,
      authorId: userThanh.id,
      starred: true,
      metaData: { pages: 32, aspectRatio: '16:9', conference: 'ICLR 2026' },
    },
  });

  await prisma.file.create({
    data: {
      filename: 'Doctoral-Defense-Presentation-Keynote.pdf',
      size: BigInt(8912896), // 8.5 MB
      mimeType: 'application/pdf',
      url: 'https://storage.rpm.local/papers/Doctoral-Defense-Presentation-Keynote.pdf',
      parentId: folderPresentations.id,
      linkedToType: 'personal',
      linkedToId: userThanh.id,
      authorId: userThanh.id,
      starred: false,
    },
  });

  // Files inside Visualizations folder
  await prisma.file.createMany({
    data: [
      {
        filename: 'loss_landscape_curvature_3d.png',
        size: BigInt(2516582), // 2.4 MB
        mimeType: 'image/png',
        url: 'https://storage.rpm.local/plots/loss_landscape_curvature_3d.png',
        parentId: folderPlots.id,
        linkedToType: 'personal',
        linkedToId: userThanh.id,
        authorId: userThanh.id,
        starred: false,
      },
      {
        filename: 'h100_vs_a100_throughput_scaling.svg',
        size: BigInt(460800), // 450 KB
        mimeType: 'image/svg+xml',
        url: 'https://storage.rpm.local/plots/h100_vs_a100_throughput_scaling.svg',
        parentId: folderPlots.id,
        linkedToType: 'personal',
        linkedToId: userThanh.id,
        authorId: userThanh.id,
        starred: true,
      },
    ],
  });

  // Project Drive Files (linked to project "flux")
  await prisma.file.createMany({
    data: [
      {
        filename: 'slurm_distributed_cluster_launch.sh',
        size: BigInt(4096),
        mimeType: 'text/x-shellscript',
        url: 'https://storage.rpm.local/projects/flux/slurm_distributed_cluster_launch.sh',
        linkedToType: 'project',
        linkedToId: projectFlux.id,
        authorId: userThanh.id,
        starred: false,
      },
      {
        filename: 'benchmark_distributed_ddp.py',
        size: BigInt(14500),
        mimeType: 'text/x-python',
        url: 'https://storage.rpm.local/projects/flux/benchmark_distributed_ddp.py',
        linkedToType: 'project',
        linkedToId: projectFlux.id,
        authorId: userThanh.id,
        starred: true,
      },
      {
        filename: 'references-master.bib',
        size: BigInt(79800),
        mimeType: 'text/plain',
        url: 'https://storage.rpm.local/projects/flux/references-master.bib',
        linkedToType: 'project',
        linkedToId: projectFlux.id,
        authorId: userThanh.id,
        starred: false,
      },
    ],
  });

  // File Shares (Collaborative Access)
  await prisma.fileShare.createMany({
    data: [
      {
        fileId: fileSlides.id,
        userId: adminUser.id,
        permission: FilePermission.edit,
      },
      {
        fileId: fileSlides.id,
        userId: reviewerUser.id,
        permission: FilePermission.view,
      },
      {
        fileId: fileCheckpoint.id,
        userId: researcherUser.id,
        permission: FilePermission.view,
      },
    ],
  });

  // ============================================================================
  // 5. AI COPILOT & RESEARCH ASSISTANT (CHATS & CONVERSATIONS)
  // ============================================================================
  console.log(
    '🤖 [5/9] Seeding AI Copilot Conversations, Latex Math Proofs & Research Questions...',
  );

  await prisma.aiMessage.deleteMany({
    where: { chat: { userId: userThanh.id } },
  });
  await prisma.aiChat.deleteMany({ where: { userId: userThanh.id } });

  // AI Chat 1: Regret bound derivation
  const chat1 = await prisma.aiChat.create({
    data: {
      userId: userThanh.id,
      projectId: projectFlux.id,
      title: 'Chứng minh Regret Bound cho AdamW với Cosine LR Annealing',
      summary:
        'Phân tích chi tiết bước nhảy từ Bổ đề 2 sang Định lý 1 trong việc chặn chuỗi tổng $\\sum_{t=1}^T \\frac{\\alpha_t}{\\sqrt{t}}$ và khử giả định gradient bị chặn toàn cục.',
      keyFacts: [
        'Cosine learning rate annealing $\\alpha_t = \\alpha_{\\min} + \\frac{1}{2}(\\alpha_{\\max} - \\alpha_{\\min})(1 + \\cos(\\frac{t\\pi}{T}))$',
        'Định lý 1 thiết lập cận hội tụ $R(T) = \\mathcal{O}(\\sqrt{T \\log T})$',
        'Kỹ thuật tính tổng Euler-Maclaurin loại bỏ nhu cầu cận trên nhân tạo',
        'Khử giả định gradient bị chặn toàn cục bằng điều kiện khả vi Lipschitz',
      ],
      openQuestions: [
        'Ảnh hưởng của hằng số phân rã trọng số tách rời (decoupled weight decay $\\lambda$) đối với bán kính hội tụ trong không gian Hilbert',
        'Tối ưu tỷ số $\\beta_1, \\beta_2$ khi ma trận Hessian có trị riêng cực đại lớn và phân bố đuôi nặng',
      ],
      createdAt: new Date(now.getTime() - 2 * dayMs),
      updatedAt: new Date(now.getTime() - 3 * hourMs),
    },
  });

  await prisma.aiMessage.createMany({
    data: [
      {
        chatId: chat1.id,
        role: MessageRole.user,
        content:
          'Hãy phân tích chi tiết bước chuyển tiếp từ Bổ đề 2 sang Định lý 1 trong việc chặn tổng $\\sum_{t=1}^T \\frac{\\alpha_t}{\\sqrt{t}}$ khi sử dụng lịch trình suy giảm Cosine Annealing.',
        createdAt: new Date(now.getTime() - 2 * dayMs),
      },
      {
        chatId: chat1.id,
        role: MessageRole.assistant,
        content:
          'Để chặn tổng $\\sum_{t=1}^T \\frac{\\alpha_t}{\\sqrt{t}}$ với lịch trình Cosine Annealing:\n\n$$\\alpha_t = \\alpha_{\\min} + \\frac{1}{2}(\\alpha_{\\max} - \\alpha_{\\min})\\left(1 + \\cos\\left(\\frac{t\\pi}{T}\\right)\\right)$$\n\nTa chia tích phân theo xấp xỉ Euler-Maclaurin:\n\n$$\\sum_{t=1}^T \\frac{\\alpha_t}{\\sqrt{t}} \\le \\int_1^T \\frac{\\alpha(t)}{\\sqrt{t}} dt + \\frac{\\alpha_1}{2} + \\frac{\\alpha_T}{2\\sqrt{T}} + \\mathcal{O}(1)$$\n\nĐặt biến phụ $u = \\sqrt{t/T}$, ta thu được cận giải tích hoàn chỉnh:\n\n$$\\int_1^T \\frac{\\cos(t\\pi/T)}{\\sqrt{t}} dt = 2\\sqrt{T} \\int_0^1 \\cos(\\pi u^2) du = \\sqrt{2T} \\cdot C(1)$$\n\ntrong đó $C(x)$ là tích phân Fresnel cosine. Vì $|C(1)| < 0.779$, toàn bộ tổng bị chặn bởi $\\mathcal{O}(\\sqrt{T})$, chứng minh rằng độ lệch tích lũy (regret) thỏa mãn tốc độ tối ưu $\\mathcal{O}(\\sqrt{T})$.',
        sources: [
          {
            title: 'Adam: A Method for Stochastic Optimization',
            doi: '10.48550/arXiv.1412.6980',
          },
          {
            title: 'On the Convergence of Adam and Beyond',
            doi: '10.48550/arXiv.1904.09237',
          },
        ],
        createdAt: new Date(now.getTime() - 2 * dayMs + 5 * minMs),
      },
      {
        chatId: chat1.id,
        role: MessageRole.user,
        content:
          'Giả định về gradient bị chặn trong không gian phi lồi có thể được nới lỏng thành giả định moment cấp 2 kỳ vọng hữu hạn không?',
        createdAt: new Date(now.getTime() - 1 * dayMs),
      },
      {
        chatId: chat1.id,
        role: MessageRole.assistant,
        content:
          'Hoàn toàn khả thi, anh Thành. Dưới giả định kỳ vọng hữu hạn điều kiện:\n\n$$\\mathbb{E}[\\|g_t\\|^2 \\mid \\mathcal{F}_t] \\le \\sigma^2 + c \\|\\nabla f(x_t)\\|^2$$\n\nTa áp dụng bất đẳng thức sai phân Martingale kết hợp bổ đề Robbins-Monro. Khi đó, đại lượng $\\hat{v}_t$ vẫn bị chặn dưới theo xác suất, và kỳ vọng regret $\\mathbb{E}[R(T)]$ vẫn giữ được trật tự $\\mathcal{O}(\\sqrt{T \\log T})$ mà không cần đòi hỏi $\\|g_t\\|_\\infty \\le G_\\infty$ đối với mọi mẫu ngẫu nhiên.',
        createdAt: new Date(now.getTime() - 1 * dayMs + 3 * minMs),
      },
    ],
  });

  // AI Chat 2: FlashAttention-2 GPU kernel optimization
  const chat2 = await prisma.aiChat.create({
    data: {
      userId: userThanh.id,
      projectId: projectFlux.id,
      title: 'Tối ưu hóa GPU Kernel FlashAttention-2 cho Hopper H100',
      summary:
        'Kỹ thuật phân chia khối nhớ SRAM (shared memory tiling), đồng bộ hóa luồng qua TMA (Tensor Memory Accelerator) và kỹ thuật Warp Specialization.',
      keyFacts: [
        'Kiến trúc Hopper SM90a bổ sung TMA tải dữ liệu bất đồng bộ không tiêu tốn chu kỳ thanh ghi',
        'Tiling chuẩn $B_r \\times B_c = 128 \\times 128$ đạt 72% peak tensor core FP16',
        'Warp Specialization: 1 Producer warp group và 2 Consumer warp groups',
      ],
      openQuestions: [
        'Hỗ trợ định dạng FP8 (E4M3 / E5M2) với tỷ lệ scaling động trên Hopper',
        'Tích hợp cơ chế sliding window attention trực tiếp vào inner loop mà không phân nhánh rẽ nhánh',
      ],
      createdAt: new Date(now.getTime() - 4 * dayMs),
      updatedAt: new Date(now.getTime() - 1 * dayMs),
    },
  });

  await prisma.aiMessage.createMany({
    data: [
      {
        chatId: chat2.id,
        role: MessageRole.user,
        content:
          'Làm thế nào để loại bỏ hoàn toàn hiện tượng register spill khi chia tile kích thước $B_r \\times B_c = 128 \\times 128$ trên Tensor Core của SXM5 H100?',
        createdAt: new Date(now.getTime() - 4 * dayMs),
      },
      {
        chatId: chat2.id,
        role: MessageRole.assistant,
        content:
          'Trên kiến trúc NVIDIA Hopper (Compute Capability 9.0a), giải pháp cốt lõi bao gồm:\n\n1. **Sử dụng TMA (Tensor Memory Accelerator)**: Thay thế câu lệnh nạp `cp.async` bằng `cp.async.bulk.tensor` để phần cứng TMA tự động nạp thẳng từ GMEM sang Shared Memory mà không thông qua tập thanh ghi của Thread.\n2. **Warp Specialization**: Tách biệt 1 nhóm warp đóng vai trò *Producer* (chỉ điều khiển TMA) và 2 nhóm warp đóng vai trò *Consumer* (chỉ thực hiện phép nhân ma trận tích chập tensor core `wgmma.mma_async`).\n3. **Giới hạn số lượng thanh ghi**: Thêm cờ biên dịch `__launch_bounds__(128, 2)` và `__attribute__((amdgpu_flat_work_group_size(1, 128)))` hoặc `maxrregcount=160` trong NVCC để trình biên dịch không cấp phát vượt ngưỡng 256 thanh ghi/thread, tránh tràn ra Local Memory (HBM).',
        sources: [
          {
            title:
              'FlashAttention-2: Faster Attention with Better Parallelism and Work Partitioning',
            doi: '10.48550/arXiv.2307.08691',
          },
        ],
        createdAt: new Date(now.getTime() - 4 * dayMs + 4 * minMs),
      },
    ],
  });

  // AI Chat 3: DeepSeek-V2 MLA analysis
  const chat3 = await prisma.aiChat.create({
    data: {
      userId: userThanh.id,
      projectId: projectFlux.id,
      title: 'So sánh cơ chế Multi-Head Latent Attention (MLA) và GQA',
      summary:
        'Phân tích chi tiết mức độ nén KV Cache của DeepSeek-V2 và tác động đến thông lượng suy luận phục vụ mô hình ngôn ngữ lớn.',
      keyFacts: [
        'MLA nén Key và Value thành latent vector $d_c \\ll n_h d_h$',
        'Tiết kiệm 93.3% dung lượng KV Cache so với MHA tiêu chuẩn',
        'Tương thích cơ chế RoPE thông qua ma trận chiếu tách rời $W^{KR}$',
      ],
      openQuestions: [],
      createdAt: new Date(now.getTime() - 6 * dayMs),
      updatedAt: new Date(now.getTime() - 5 * dayMs),
    },
  });

  await prisma.aiMessage.createMany({
    data: [
      {
        chatId: chat3.id,
        role: MessageRole.user,
        content:
          'Cơ chế nén KV cache thành latent vector trong DeepSeek-V2 MLA giúp tiết kiệm băng thông bộ nhớ như thế nào so với Grouped-Query Attention (GQA)?',
        createdAt: new Date(now.getTime() - 6 * dayMs),
      },
      {
        chatId: chat3.id,
        role: MessageRole.assistant,
        content:
          'Trong Grouped-Query Attention (GQA-8), kích thước KV cache cho mỗi token là $2 \\times n_{kv} \\times d_h = 2 \\times 8 \\times 128 = 2048$ bytes (ở định dạng FP16).\n\nTrong khi đó, Multi-Head Latent Attention (MLA) của DeepSeek-V2 nén toàn bộ Key và Value của 128 heads thành một vector tiềm ẩn nén duy nhất:\n\n$$c_t^{KV} \\in \\mathbb{R}^{d_c}, \\quad d_c = 512$$\n\nCộng thêm vector RoPE tách rời $k_t^R \\in \\mathbb{R}^{64}$, tổng dung lượng lưu trữ chỉ là:\n\n$$(512 + 64) \\times 2 = 1152 \\text{ bytes}$$\n\nĐiều này giúp giảm dung lượng KV cache xuống chỉ còn khoảng **6.7%** so với MHA chuẩn và **56%** so với GQA-8, cho phép tăng batch size suy luận lên gấp 4-5 lần trên cùng một máy chủ GPU H100.',
        sources: [
          {
            title:
              'DeepSeek-V2: A Strong, Economical, and Efficient Mixture-of-Experts Language Model',
            doi: '10.48550/arXiv.2405.04434',
          },
        ],
        createdAt: new Date(now.getTime() - 6 * dayMs + 6 * minMs),
      },
    ],
  });

  // ============================================================================
  // 6. MANUSCRIPTS & LATEX SUBSYSTEM (COMMENTS, TRACK CHANGES, SNAPSHOTS, TEMPLATES)
  // ============================================================================
  console.log(
    '📝 [6/9] Seeding LaTeX Review Comments, Track Changes, History Snapshots & Official Templates...',
  );

  // Find manuscript nodes for project flux
  const mainDocNode = await prisma.manuscriptNode.findFirst({
    where: {
      projectId: projectFlux.id,
      type: 'DOC',
      path: { contains: 'main.tex' },
    },
  });
  const introDocNode = await prisma.manuscriptNode.findFirst({
    where: {
      projectId: projectFlux.id,
      type: 'DOC',
      path: { contains: 'sec1_introduction' },
    },
  });
  const targetDocId = mainDocNode?.docId || introDocNode?.docId;

  if (targetDocId) {
    // Clean previous review threads on project flux
    await prisma.manuscriptCommentReply.deleteMany({
      where: { thread: { projectId: projectFlux.id } },
    });
    await prisma.manuscriptCommentThread.deleteMany({
      where: { projectId: projectFlux.id },
    });
    await prisma.manuscriptTrackChange.deleteMany({
      where: { projectId: projectFlux.id },
    });

    // Seed Comment Threads on LaTeX documents
    const thread1 = await prisma.manuscriptCommentThread.create({
      data: {
        projectId: projectFlux.id,
        docId: targetDocId,
        quote: '\\begin{theorem}[Non-Convex Regret Bound]',
        startLine: 35,
        startCol: 1,
        endLine: 35,
        endCol: 42,
        isResolved: false,
        createdById: reviewerUser.id,
        createdAt: new Date(now.getTime() - 3 * dayMs),
      },
    });

    await prisma.manuscriptCommentReply.createMany({
      data: [
        {
          threadId: thread1.id,
          content:
            'Cần bổ sung điều kiện giả định Lipschitz smoothness của hàm mục tiêu $f(x)$ với hằng số $L$ cụ thể trước khi phát biểu Định lý 1.',
          createdById: reviewerUser.id,
          createdAt: new Date(now.getTime() - 3 * dayMs),
        },
        {
          threadId: thread1.id,
          content:
            'Đã bổ sung Giả định 2.1 trong phần Phụ lục A với hằng số $L$-Lipschitz và trích dẫn bổ đề kiểm chứng.',
          createdById: userThanh.id,
          createdAt: new Date(now.getTime() - 2 * dayMs),
        },
      ],
    });

    const thread2 = await prisma.manuscriptCommentThread.create({
      data: {
        projectId: projectFlux.id,
        docId: targetDocId,
        quote: '\\cite{vaswani2017attention}',
        startLine: 18,
        startCol: 15,
        endLine: 18,
        endCol: 41,
        isResolved: true,
        createdById: researcherUser.id,
        resolvedById: userThanh.id,
        resolvedAt: new Date(now.getTime() - 1 * dayMs),
        createdAt: new Date(now.getTime() - 5 * dayMs),
      },
    });

    await prisma.manuscriptCommentReply.createMany({
      data: [
        {
          threadId: thread2.id,
          content:
            'Nên trích dẫn thêm bài báo mở rộng FlashAttention-2 (Dao, 2023) bên cạnh bài báo gốc Transformer.',
          createdById: researcherUser.id,
          createdAt: new Date(now.getTime() - 5 * dayMs),
        },
        {
          threadId: thread2.id,
          content:
            'Đã cập nhật trích dẫn kép `\\cite{vaswani2017attention,dao2023flashattention2}` trong file .tex.',
          createdById: userThanh.id,
          createdAt: new Date(now.getTime() - 1 * dayMs),
        },
      ],
    });

    // Seed Track Changes / Suggestions
    await prisma.manuscriptTrackChange.createMany({
      data: [
        {
          projectId: projectFlux.id,
          docId: targetDocId,
          type: ManuscriptChangeType.insert,
          status: ManuscriptChangeStatus.pending,
          text: 'Furthermore, our decoupled momentum clipping mechanism eliminates pathological gradient saturation under long-tailed distributions.',
          startLine: 48,
          startCol: 1,
          endLine: 48,
          endCol: 132,
          createdById: researcherUser.id,
          createdAt: new Date(now.getTime() - 18 * hourMs),
        },
        {
          projectId: projectFlux.id,
          docId: targetDocId,
          type: ManuscriptChangeType.delete,
          status: ManuscriptChangeStatus.accepted,
          text: 'which was previously considered an intractable computational open problem in polynomial time.',
          startLine: 55,
          startCol: 10,
          endLine: 55,
          endCol: 104,
          createdById: adminUser.id,
          resolvedById: userThanh.id,
          resolvedAt: new Date(now.getTime() - 12 * hourMs),
          createdAt: new Date(now.getTime() - 2 * dayMs),
        },
      ],
    });
  }

  // Manuscript Snapshots & Labels (Git-like Version History)
  await prisma.manuscriptLabel.deleteMany({
    where: { projectId: projectFlux.id },
  });
  await prisma.manuscriptSnapshot.deleteMany({
    where: { projectId: projectFlux.id },
  });

  const snap1 = await prisma.manuscriptSnapshot.create({
    data: {
      projectId: projectFlux.id,
      version: 1,
      summary: 'Bản thảo phác thảo sơ bộ (Initial Draft - Sections 1 đến 5)',
      createdById: userThanh.id,
      sizeBytes: 145000,
      createdAt: new Date(now.getTime() - 25 * dayMs),
    },
  });
  await prisma.manuscriptLabel.create({
    data: {
      projectId: projectFlux.id,
      snapshotId: snap1.id,
      version: 1,
      label: 'v1.0-Initial-Draft',
      createdById: userThanh.id,
      createdAt: new Date(now.getTime() - 25 * dayMs),
    },
  });

  const snap2 = await prisma.manuscriptSnapshot.create({
    data: {
      projectId: projectFlux.id,
      version: 2,
      summary:
        'Bổ sung đầy đủ chứng minh Định lý 1 và bảng thử nghiệm benchmark trên 8x H100',
      createdById: userThanh.id,
      sizeBytes: 280000,
      createdAt: new Date(now.getTime() - 10 * dayMs),
    },
  });
  await prisma.manuscriptLabel.create({
    data: {
      projectId: projectFlux.id,
      snapshotId: snap2.id,
      version: 2,
      label: 'v2.0-Benchmark-Complete',
      createdById: userThanh.id,
      createdAt: new Date(now.getTime() - 10 * dayMs),
    },
  });

  const snap3 = await prisma.manuscriptSnapshot.create({
    data: {
      projectId: projectFlux.id,
      version: 3,
      summary:
        'Bản hoàn thiện nộp hội nghị ICLR 2026 Camera-Ready (18 trang PDF)',
      createdById: userThanh.id,
      sizeBytes: 395000,
      createdAt: new Date(now.getTime() - 1 * dayMs),
    },
  });
  await prisma.manuscriptLabel.create({
    data: {
      projectId: projectFlux.id,
      snapshotId: snap3.id,
      version: 3,
      label: 'v3.0-Camera-Ready',
      createdById: userThanh.id,
      createdAt: new Date(now.getTime() - 1 * dayMs),
    },
  });

  // Manuscript Official Templates
  await prisma.manuscriptTemplate.deleteMany();
  await prisma.manuscriptTemplate.createMany({
    data: [
      {
        versionId: 'neurips-2025-v1',
        name: 'NeurIPS Conference Template (2025/2026)',
        category: ManuscriptTemplateCategory.conference,
        description:
          'Mẫu chuẩn chính thức của Hội nghị NeurIPS (Advances in Neural Information Processing Systems) kèm file style neurips_2025.sty và checklist.',
        compiler: 'pdflatex',
        mainFile: 'main.tex',
        author: 'NeurIPS Organizing Committee',
        tags: ['NeurIPS', 'Machine Learning', 'AI', 'Conference'],
        isOfficial: true,
        downloadCount: 3840,
      },
      {
        versionId: 'icml-2025-v1',
        name: 'ICML Proceedings Official Template',
        category: ManuscriptTemplateCategory.conference,
        description:
          'Khuôn mẫu bài viết cho Hội nghị Quốc tế về Học máy ICML, cấu hình 2 cột và gói thuật toán icml2025.sty.',
        compiler: 'pdflatex',
        mainFile: 'main.tex',
        author: 'International Machine Learning Society',
        tags: ['ICML', 'Machine Learning', 'Conference'],
        isOfficial: true,
        downloadCount: 2910,
      },
      {
        versionId: 'ieee-tpami-v1',
        name: 'IEEE Transactions on Pattern Analysis and Machine Intelligence (TPAMI)',
        category: ManuscriptTemplateCategory.journal,
        description:
          'Khuôn mẫu định dạng tạp chí IEEE TPAMI đỉnh cao, định dạng chuẩn IEEEtran.cls hai cột với font chữ tiêu chuẩn Times Roman.',
        compiler: 'pdflatex',
        mainFile: 'main.tex',
        author: 'IEEE Computer Society',
        tags: ['IEEE', 'TPAMI', 'Q1-Journal', 'Computer Vision'],
        isOfficial: true,
        downloadCount: 4200,
      },
      {
        versionId: 'nature-portfolio-v1',
        name: 'Springer Nature Journal Format',
        category: ManuscriptTemplateCategory.journal,
        description:
          'Mẫu nộp bài chính thức cho các tạp chí thuộc hệ sinh thái Springer Nature (Nature Machine Intelligence, Scientific Reports).',
        compiler: 'pdflatex',
        mainFile: 'main.tex',
        author: 'Springer Nature',
        tags: ['Nature', 'Springer', 'Science', 'Journal'],
        isOfficial: true,
        downloadCount: 1950,
      },
      {
        versionId: 'beamer-flux-modern-v1',
        name: 'Beamer Academic Presentation (Modern Flux Theme)',
        category: ManuscriptTemplateCategory.presentation,
        description:
          'Khuôn mẫu slide thuyết trình bảo vệ luận án và thuyết trình hội nghị với phong cách tối giản hiện đại (16:9 widescreen, Metropolis theme).',
        compiler: 'pdflatex',
        mainFile: 'presentation.tex',
        author: 'Flux Academic Team',
        tags: ['Beamer', 'Presentation', 'Slides', 'Defense'],
        isOfficial: true,
        downloadCount: 1620,
      },
      {
        versionId: 'phd-thesis-monograph-v1',
        name: 'Doctoral Dissertation & PhD Thesis Template',
        category: ManuscriptTemplateCategory.thesis,
        description:
          'Khuôn mẫu toàn diện cho Luận án Tiến sĩ: Bìa chuẩn ĐHQG, mục lục đa cấp, danh mục hình vẽ, bảng biểu và phụ lục toán học.',
        compiler: 'pdflatex',
        mainFile: 'thesis.tex',
        author: 'VNU Graduate School',
        tags: ['PhD', 'Thesis', 'Dissertation', 'Book'],
        isOfficial: true,
        downloadCount: 1140,
      },
    ],
  });

  // ============================================================================
  // 7. INBOX & NOTIFICATIONS
  // ============================================================================
  console.log(
    '🔔 [7/9] Seeding Collaborative Inbox Notifications (Mentions, Reviews, Invites)...',
  );

  await prisma.manuscriptNotification.deleteMany({
    where: { userId: userThanh.id },
  });
  await prisma.manuscriptNotification.createMany({
    data: [
      {
        userId: userThanh.id,
        templateKey: 'comment_mention',
        type: ManuscriptNotificationType.mention,
        projectId: projectFlux.id,
        actorId: researcherUser.id,
        messageOpts: {
          actorName: 'Alex Chen',
          docPath: 'main.tex',
          commentPreview:
            '@thanh.ngo Đã kiểm tra lại hằng số Lipschitz trong Bổ đề 2, nhờ Thầy xác nhận lần cuối.',
        },
        isRead: false,
        createdAt: new Date(now.getTime() - 25 * minMs),
      },
      {
        userId: userThanh.id,
        templateKey: 'comment_reply',
        type: ManuscriptNotificationType.comment_reply,
        projectId: projectFlux.id,
        actorId: adminUser.id,
        messageOpts: {
          actorName: 'Dr. Evelyn Vance',
          docPath: 'tables/table1_benchmarks.tex',
          replyPreview:
            'Kết quả MFU 58.4% trên cụm H100 đã được kiểm chứng khớp với log PyTorch profiler.',
        },
        isRead: false,
        createdAt: new Date(now.getTime() - 2 * hourMs),
      },
      {
        userId: userThanh.id,
        templateKey: 'review_request',
        type: ManuscriptNotificationType.review_request,
        projectId: projectFlux.id,
        actorId: reviewerUser.id,
        messageOpts: {
          actorName: 'Dr. Marcus Brody',
          summary:
            'Bản đánh giá phản biện cho bài báo nộp ICLR 2026 đã sẵn sàng xem xét.',
        },
        isRead: false,
        createdAt: new Date(now.getTime() - 6 * hourMs),
      },
      {
        userId: userThanh.id,
        templateKey: 'project_invite',
        type: ManuscriptNotificationType.project_invite,
        projectId: projectNpde.id,
        actorId: adminUser.id,
        messageOpts: {
          projectName: 'Mô hình Toán tử Sâu & PINNs Đa Pha',
          role: 'Chủ nhiệm đề tài (Owner)',
        },
        isRead: true,
        readAt: new Date(now.getTime() - 1 * dayMs),
        createdAt: new Date(now.getTime() - 2 * dayMs),
      },
      {
        userId: userThanh.id,
        templateKey: 'compilation_success',
        type: ManuscriptNotificationType.system,
        projectId: projectFlux.id,
        messageOpts: {
          documentTitle: 'FLUX Research Monograph (Adam Optimization)',
          pageCount: 18,
          compilationTimeSec: 2.8,
          warnings: 0,
        },
        isRead: true,
        readAt: new Date(now.getTime() - 10 * hourMs),
        createdAt: new Date(now.getTime() - 12 * hourMs),
      },
    ],
  });

  // ============================================================================
  // 8. THIRD-PARTY INTEGRATIONS (ZOTERO, GITHUB, ORCID, MENDELEY)
  // ============================================================================
  console.log(
    '🔗 [8/9] Seeding Third-Party Academic Integrations (Zotero, GitHub, ORCID, Mendeley)...',
  );

  await prisma.projectIntegrationLink.deleteMany({
    where: { projectId: projectFlux.id },
  });
  await prisma.userIntegration.deleteMany({
    where: { userId: userThanh.id },
  });

  const intZotero = await prisma.userIntegration.create({
    data: {
      userId: userThanh.id,
      provider: IntegrationProvider.zotero,
      status: IntegrationStatus.connected,
      accessToken: 'enc:v1:aes-256-gcm:zotero-auth-token-sample',
      providerUserId: '10482915',
      accountName: 'ngotanthanh',
      accountEmail: userThanh.email,
      metadata: {
        totalItems: 19,
        collections: 11,
        storageQuotaMB: 300,
        storageUsedMB: 42.5,
        syncMode: 'bidirectional',
        lastSyncStatus: 'OK (0 errors)',
      },
      connectedAt: new Date(now.getTime() - 40 * dayMs),
      lastSyncedAt: new Date(now.getTime() - 12 * minMs),
    },
  });

  await prisma.userIntegration.create({
    data: {
      userId: userThanh.id,
      provider: IntegrationProvider.github,
      status: IntegrationStatus.connected,
      accessToken: 'enc:v1:aes-256-gcm:github-pat-token-sample',
      providerUserId: 'ngotanthanh-research',
      accountName: 'Tấn Thành (Lab Leader)',
      accountEmail: userThanh.email,
      metadata: {
        repositories: [
          'flux-research-core',
          'neural-operator-suite',
          'adamw-regret-proofs',
        ],
        organizations: ['VNU-AI-Lab', 'Flux-Ecosystem'],
        starredRepos: 142,
      },
      connectedAt: new Date(now.getTime() - 50 * dayMs),
      lastSyncedAt: new Date(now.getTime() - 45 * minMs),
    },
  });

  await prisma.userIntegration.create({
    data: {
      userId: userThanh.id,
      provider: IntegrationProvider.orcid,
      status: IntegrationStatus.connected,
      accessToken: 'enc:v1:aes-256-gcm:orcid-token-sample',
      providerUserId: '0000-0002-1825-0097',
      accountName: 'Ngo Tan Thanh, PhD',
      accountEmail: userThanh.email,
      metadata: {
        orcid: '0000-0002-1825-0097',
        verifiedWorks: 28,
        hIndex: 19,
        totalCitations: 2480,
      },
      connectedAt: new Date(now.getTime() - 60 * dayMs),
      lastSyncedAt: new Date(now.getTime() - 120 * minMs),
    },
  });

  await prisma.userIntegration.create({
    data: {
      userId: userThanh.id,
      provider: IntegrationProvider.mendeley,
      status: IntegrationStatus.connected,
      accessToken: 'enc:v1:aes-256-gcm:mendeley-token-sample',
      providerUserId: 'mendeley-thanh-ngo',
      accountName: 'Thanh Ngo (Mendeley)',
      metadata: { sharedGroups: 3, papersArchived: 64 },
      connectedAt: new Date(now.getTime() - 35 * dayMs),
      lastSyncedAt: new Date(now.getTime() - 24 * hourMs),
    },
  });

  // Project Integration Link (Zotero collection synced into references.bib)
  const zoteroCol = await prisma.collection.findFirst({
    where: { name: { contains: 'Foundation Models' } },
  });

  await prisma.projectIntegrationLink.create({
    data: {
      projectId: projectFlux.id,
      userIntegrationId: intZotero.id,
      collectionId: zoteroCol?.id || 'col-zotero-foundations',
      collectionName: 'Foundation Models & LLM Architectures',
      targetBibFile: 'references.bib',
      lastSyncedAt: new Date(now.getTime() - 12 * minMs),
    },
  });

  // ============================================================================
  // 9. AUDIT LOGS & ACTIVITY STREAM (TIMELINE ACROSS ALL MODULES)
  // ============================================================================
  console.log(
    '📊 [9/9] Generating Activity Events Stream & Audit Trail Logs...',
  );

  await prisma.activityEvent.deleteMany({ where: { actorId: userThanh.id } });
  await prisma.activityEvent.createMany({
    data: [
      {
        entityType: EntityType.work_item,
        entityId: workItemsBySeq.get(19) || userThanh.id,
        verb: 'updated_status',
        field: 'column_id',
        oldValue: 'todo',
        newValue: 'in_progress',
        actorId: userThanh.id,
        projectId: projectFlux.id,
        createdAt: new Date(now.getTime() - 2 * hourMs),
      },
      {
        entityType: EntityType.comment,
        entityId: workItemsBySeq.get(19) || userThanh.id,
        verb: 'created_comment',
        actorId: userThanh.id,
        projectId: projectFlux.id,
        createdAt: new Date(now.getTime() - 3 * hourMs),
      },
      {
        entityType: EntityType.file,
        entityId: fileSlides.id,
        verb: 'uploaded_file',
        newValue: 'ICLR2026-Oral-Presentation-Slides.pdf',
        actorId: userThanh.id,
        projectId: projectFlux.id,
        createdAt: new Date(now.getTime() - 5 * hourMs),
      },
      {
        entityType: EntityType.paper,
        entityId: flashAttentionItem?.id || userThanh.id,
        verb: 'starred_paper',
        actorId: userThanh.id,
        projectId: projectFlux.id,
        createdAt: new Date(now.getTime() - 8 * hourMs),
      },
      {
        entityType: EntityType.project,
        entityId: projectFlux.id,
        verb: 'posted_update',
        newValue: 'Đã hoàn thiện bản thảo ICLR 2026 với 10 mục chính...',
        actorId: userThanh.id,
        projectId: projectFlux.id,
        createdAt: new Date(now.getTime() - 1 * dayMs),
      },
      {
        entityType: EntityType.collection,
        entityId: zoteroCol?.id || userThanh.id,
        verb: 'synced_zotero',
        newValue: '19 tài liệu tham khảo đồng bộ thành công',
        actorId: userThanh.id,
        projectId: projectFlux.id,
        createdAt: new Date(now.getTime() - 2 * dayMs),
      },
      {
        entityType: EntityType.sticky,
        entityId: userThanh.id,
        verb: 'created_sticky',
        newValue: 'ICLR Camera-Ready Checklist',
        actorId: userThanh.id,
        createdAt: new Date(now.getTime() - 3 * dayMs),
      },
    ],
  });

  // Audit Logs
  await prisma.auditLog.deleteMany({ where: { actorId: userThanh.id } });
  await prisma.auditLog.createMany({
    data: [
      {
        actorId: userThanh.id,
        action: 'user.login.google_oauth',
        outcome: AuditOutcome.success,
        severity: AuditSeverity.info,
        ipAddress: '14.238.102.45',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0.0.0',
        metadata: { provider: 'google', email: userThanh.email },
        occurredAt: new Date(now.getTime() - 15 * minMs),
      },
      {
        actorId: userThanh.id,
        action: 'manuscripts.compile.pdf',
        outcome: AuditOutcome.success,
        severity: AuditSeverity.info,
        projectId: projectFlux.id,
        targetType: 'manuscript_doc',
        targetId: targetDocId || 'doc-main',
        ipAddress: '14.238.102.45',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        metadata: { compiler: 'pdflatex', durationMs: 2840, pages: 18 },
        occurredAt: new Date(now.getTime() - 2 * hourMs),
      },
      {
        actorId: userThanh.id,
        action: 'library.export.bibtex',
        outcome: AuditOutcome.success,
        severity: AuditSeverity.info,
        projectId: projectFlux.id,
        targetType: 'collection',
        ipAddress: '14.238.102.45',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        metadata: { exportedEntries: 19, format: 'bibtex' },
        occurredAt: new Date(now.getTime() - 6 * hourMs),
      },
      {
        actorId: userThanh.id,
        action: 'storage.file.share',
        outcome: AuditOutcome.success,
        severity: AuditSeverity.info,
        targetType: 'file',
        targetId: fileSlides.id,
        ipAddress: '14.238.102.45',
        metadata: { recipient: 'admin@rpm.local', permission: 'edit' },
        occurredAt: new Date(now.getTime() - 1 * dayMs),
      },
      {
        actorId: userThanh.id,
        action: 'project.settings.update',
        outcome: AuditOutcome.success,
        severity: AuditSeverity.info,
        projectId: projectFlux.id,
        ipAddress: '14.238.102.45',
        metadata: { priority: 'high' },
        occurredAt: new Date(now.getTime() - 3 * dayMs),
      },
    ],
  });

  // ============================================================================
  // 10. INVALIDATE REDIS CACHES ACROSS ALL SERVICES
  // ============================================================================
  console.log(
    '🧹 Invalidate Redis caches across all services for instant UI reactivity...',
  );
  try {
    const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    const allKeys = await redis.keys('*');
    if (allKeys.length > 0) {
      await redis.del(...allKeys);
      console.log(
        `   ✅ Flushed ${allKeys.length} Redis cache keys across all namespaces.`,
      );
    }
    await redis.quit();
  } catch (err) {
    console.warn(
      '   ⚠️ Redis flush skipped or unavailable:',
      (err as Error).message,
    );
  }

  console.log(
    '🎉 [DONE] All platform features have been thoroughly seeded with realistic academic data!',
  );
}

seedAllFeatures()
  .catch((e) => {
    console.error('❌ Error seeding all features:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
