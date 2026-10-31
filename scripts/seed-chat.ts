import 'dotenv/config';
import {
  PrismaClient,
  ConversationType,
  ConversationMemberRole,
  FriendshipStatus,
  MessageType,
  Role,
} from '@prisma/client';
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

async function run() {
  console.log('🚀 Starting realistic Chat database seeding for ngotanthanh92.26@gmail.com...');

  // 1. Fetch Primary User Thanh
  const userThanh = await prisma.user.findFirst({
    where: { email: 'ngotanthanh92.26@gmail.com' },
    include: { profile: true },
  });

  if (!userThanh) {
    throw new Error('User ngotanthanh92.26@gmail.com not found in database. Run base seed first!');
  }
  console.log(`✅ Located Primary User: ${userThanh.email} (${userThanh.id})`);

  // 2. Ensure academic & engineering collaborators exist
  let adminUser = await prisma.user.findFirst({ where: { email: 'admin@rpm.local' }, include: { profile: true } });
  let researcherUser = await prisma.user.findFirst({ where: { email: 'researcher@rpm.local' }, include: { profile: true } });
  let reviewerUser = await prisma.user.findFirst({ where: { email: 'reviewer@rpm.local' }, include: { profile: true } });
  let sophiaUser = await prisma.user.findFirst({ where: { email: 'sophia.lin@rpm.local' }, include: { profile: true } });
  let davidUser = await prisma.user.findFirst({ where: { email: 'david.m@univ.edu' }, include: { profile: true } });

  if (!adminUser) {
    adminUser = await prisma.user.create({
      data: {
        email: 'admin@rpm.local',
        password: 'hashed_password_placeholder',
        status: 'active',
        profile: {
          create: {
            name: 'Dr. Evelyn Vance',
            avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
          },
        },
      },
      include: { profile: true },
    });
  }

  if (!researcherUser) {
    researcherUser = await prisma.user.create({
      data: {
        email: 'researcher@rpm.local',
        password: 'hashed_password_placeholder',
        status: 'active',
        profile: {
          create: {
            name: 'Alex Chen',
            avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150',
          },
        },
      },
      include: { profile: true },
    });
  }

  if (!reviewerUser) {
    reviewerUser = await prisma.user.create({
      data: {
        email: 'reviewer@rpm.local',
        password: 'hashed_password_placeholder',
        status: 'active',
        profile: {
          create: {
            name: 'Dr. Marcus Brody',
            avatar: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150',
          },
        },
      },
      include: { profile: true },
    });
  }

  if (!sophiaUser) {
    sophiaUser = await prisma.user.create({
      data: {
        email: 'sophia.lin@rpm.local',
        password: 'hashed_password_placeholder',
        status: 'active',
        profile: {
          create: {
            name: 'Dr. Sophia Lin',
            avatar: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150',
          },
        },
      },
      include: { profile: true },
    });
  }

  if (!davidUser) {
    davidUser = await prisma.user.create({
      data: {
        email: 'david.m@univ.edu',
        password: 'hashed_password_placeholder',
        status: 'active',
        profile: {
          create: {
            name: 'David Miller',
            avatar: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=150',
          },
        },
      },
      include: { profile: true },
    });
  }

  // 3. Find target Project (prefer "flux")
  let project = await prisma.project.findFirst({
    where: { name: 'flux' },
  });

  if (!project) {
    project = await prisma.project.findFirst({
      where: {
        OR: [
          { createdById: userThanh.id },
          { members: { some: { userId: userThanh.id } } },
        ],
      },
    });
  }

  if (!project) {
    throw new Error('No project found for user. Run base project seed first!');
  }
  console.log(`✅ Located Target Project: ${project.name} (${project.id})`);

  // Ensure project membership for collaborators
  for (const collab of [adminUser, researcherUser, reviewerUser, sophiaUser]) {
    const existing = await prisma.projectMember.findFirst({
      where: { projectId: project.id, userId: collab.id },
    });
    if (!existing) {
      await prisma.projectMember.create({
        data: {
          projectId: project.id,
          userId: collab.id,
          role: Role.contributor,
        },
      });
    }
  }

  // 4. CLEAN EXISTING CHAT DATA IDEMPOTENTLY
  console.log('🧹 Cleaning existing chat conversations & friendships...');
  const existingConvMembers = await prisma.conversationMember.findMany({
    where: { userId: userThanh.id },
    select: { conversationId: true },
  });
  const projectChannels = await prisma.conversation.findMany({
    where: { projectId: project.id, type: ConversationType.project_channel },
    select: { id: true },
  });

  const existingConvIds = Array.from(
    new Set([
      ...existingConvMembers.map((m) => m.conversationId),
      ...projectChannels.map((c) => c.id),
    ]),
  );

  if (existingConvIds.length > 0) {
    await prisma.messageReaction.deleteMany({
      where: { message: { conversationId: { in: existingConvIds } } },
    });
    await prisma.message.deleteMany({
      where: { conversationId: { in: existingConvIds } },
    });
    await prisma.conversationMember.deleteMany({
      where: { conversationId: { in: existingConvIds } },
    });
    await prisma.conversation.deleteMany({
      where: { id: { in: existingConvIds } },
    });
  }

  await prisma.friendship.deleteMany({
    where: { OR: [{ requesterId: userThanh.id }, { addresseeId: userThanh.id }] },
  });

  // 5. SEED FRIENDSHIPS & PENDING REQUESTS
  console.log('🤝 Seeding friendships & pending requests...');
  await prisma.friendship.createMany({
    data: [
      {
        requesterId: userThanh.id,
        addresseeId: adminUser.id,
        status: FriendshipStatus.accepted,
        createdAt: new Date(Date.now() - 30 * 86400000),
      },
      {
        requesterId: researcherUser.id,
        addresseeId: userThanh.id,
        status: FriendshipStatus.accepted,
        createdAt: new Date(Date.now() - 25 * 86400000),
      },
      {
        requesterId: userThanh.id,
        addresseeId: reviewerUser.id,
        status: FriendshipStatus.accepted,
        createdAt: new Date(Date.now() - 20 * 86400000),
      },
      {
        requesterId: sophiaUser.id,
        addresseeId: userThanh.id,
        status: FriendshipStatus.accepted,
        createdAt: new Date(Date.now() - 15 * 86400000),
      },
      {
        requesterId: davidUser.id,
        addresseeId: userThanh.id,
        status: FriendshipStatus.pending,
        createdAt: new Date(Date.now() - 2 * 3600000),
      },
    ],
  });

  // 6. SEED PROJECT CHANNELS (Discord-style)
  console.log('📢 Seeding project channels under #flux...');

  // 6.1 Channel #general (Default)
  const chGeneral = await prisma.conversation.create({
    data: {
      type: ConversationType.project_channel,
      name: 'general',
      topic: 'General team announcements, release updates, and milestone tracking for Flux',
      projectId: project.id,
      isDefault: true,
      createdById: userThanh.id,
      createdAt: new Date(Date.now() - 14 * 86400000),
      lastMessageAt: new Date(Date.now() - 15 * 60000),
      lastSenderName: 'Tấn Thành',
      lastMessageSnippet: "Thanks team! I'm now drafting the conclusion and compiling the camera-ready version.",
      members: {
        create: [
          { userId: userThanh.id, role: ConversationMemberRole.owner, lastReadAt: new Date() },
          { userId: adminUser.id, role: ConversationMemberRole.admin, lastReadAt: new Date() },
          { userId: researcherUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
          { userId: reviewerUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
          { userId: sophiaUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
        ],
      },
    },
  });

  const gMsg1 = await prisma.message.create({
    data: {
      conversationId: chGeneral.id,
      senderId: adminUser.id,
      type: MessageType.text,
      content: 'Welcome everyone to the Flux core research workspace! All project documents, LaTeX files, and datasets are linked here.',
      createdAt: new Date(Date.now() - 5 * 86400000),
    },
  });

  const gMsg2 = await prisma.message.create({
    data: {
      conversationId: chGeneral.id,
      senderId: researcherUser.id,
      type: MessageType.text,
      content: 'Cloned repository and verified local compilation with TeXLive 2026. Everything builds cleanly.',
      createdAt: new Date(Date.now() - 4 * 86400000),
    },
  });

  const gMsg3 = await prisma.message.create({
    data: {
      conversationId: chGeneral.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Milestone 4.2 completed: LaTeX monograph multi-file tree verified and synchronized.',
      createdAt: new Date(Date.now() - 3 * 86400000),
    },
  });

  const gMsg4 = await prisma.message.create({
    data: {
      conversationId: chGeneral.id,
      senderId: researcherUser.id,
      type: MessageType.text,
      content: 'Awesome! I ran a full build test with `latexmk -pdf -synctex=1 monograph.tex`, finished in 3.4 seconds without any missing macro warnings.',
      replyToId: gMsg3.id,
      createdAt: new Date(Date.now() - 2 * 86400000),
    },
  });

  const gMsg5 = await prisma.message.create({
    data: {
      conversationId: chGeneral.id,
      senderId: adminUser.id,
      type: MessageType.text,
      content: 'The review committee requested the updated benchmark chapter by Friday. Can we ensure the Overleaf/Flux bi-directional sync is tested before the weekend?',
      createdAt: new Date(Date.now() - 1 * 86400000),
    },
  });

  const gMsg6 = await prisma.message.create({
    data: {
      conversationId: chGeneral.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Dạ vâng cô, em vừa test bi-directional sync với Git bridge sáng nay. Tất cả công thức toán học và môi trường table đều render chuẩn xác 100% trên cả 2 bên ạ.',
      replyToId: gMsg5.id,
      createdAt: new Date(Date.now() - 8 * 3600000),
    },
  });

  const gMsg7 = await prisma.message.create({
    data: {
      conversationId: chGeneral.id,
      senderId: reviewerUser.id,
      type: MessageType.text,
      content: 'I reviewed Section 4.5. The lemma proofs in Appendix B look clean, and cross-references link directly to Eq. (12) without broken labels.',
      createdAt: new Date(Date.now() - 4 * 3600000),
    },
  });

  const gMsg8 = await prisma.message.create({
    data: {
      conversationId: chGeneral.id,
      senderId: researcherUser.id,
      type: MessageType.text,
      content: "Great to hear! I'll trigger the automated CI spellcheck and bibtex duplicate detector right away.",
      createdAt: new Date(Date.now() - 1 * 3600000),
    },
  });

  const gMsg9 = await prisma.message.create({
    data: {
      conversationId: chGeneral.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: "Thanks team! I'm now drafting the conclusion and compiling the camera-ready version.",
      createdAt: new Date(Date.now() - 15 * 60000),
    },
  });

  await prisma.messageReaction.createMany({
    data: [
      { messageId: gMsg4.id, userId: userThanh.id, emoji: '🔥', createdAt: new Date(Date.now() - 2 * 86400000 + 1800000) },
      { messageId: gMsg4.id, userId: adminUser.id, emoji: '👍', createdAt: new Date(Date.now() - 2 * 86400000 + 3600000) },
      { messageId: gMsg6.id, userId: adminUser.id, emoji: '❤️', createdAt: new Date(Date.now() - 7 * 3600000) },
      { messageId: gMsg6.id, userId: researcherUser.id, emoji: '👍', createdAt: new Date(Date.now() - 6 * 3600000) },
      { messageId: gMsg7.id, userId: userThanh.id, emoji: '💡', createdAt: new Date(Date.now() - 3 * 3600000) },
      { messageId: gMsg8.id, userId: userThanh.id, emoji: '🚀', createdAt: new Date(Date.now() - 45 * 60000) },
      { messageId: gMsg9.id, userId: adminUser.id, emoji: '🎉', createdAt: new Date(Date.now() - 10 * 60000) },
      { messageId: gMsg9.id, userId: researcherUser.id, emoji: '👏', createdAt: new Date(Date.now() - 8 * 60000) },
    ],
  });

  // 6.2 Channel #gpu-cluster-benchmarks
  const chGpu = await prisma.conversation.create({
    data: {
      type: ConversationType.project_channel,
      name: 'gpu-cluster-benchmarks',
      topic: 'GPU cluster jobs, SLURM queuing, throughput, and hardware telemetry',
      projectId: project.id,
      isDefault: false,
      createdById: userThanh.id,
      createdAt: new Date(Date.now() - 12 * 86400000),
      lastMessageAt: new Date(Date.now() - 35 * 60000),
      lastSenderName: 'Alex Chen',
      lastMessageSnippet: 'At this throughput, 100 epochs will take roughly 14 hours instead of 22 hours. Zero OOM errors.',
      members: {
        create: [
          { userId: userThanh.id, role: ConversationMemberRole.owner, lastReadAt: new Date() },
          { userId: researcherUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
          { userId: adminUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
        ],
      },
    },
  });

  const gpuMsg1 = await prisma.message.create({
    data: {
      conversationId: chGpu.id,
      senderId: researcherUser.id,
      type: MessageType.text,
      content: 'Node 04 InfiniBand link is back online at 400 Gbps.',
      createdAt: new Date(Date.now() - 24 * 3600000),
    },
  });

  const gpuMsg2 = await prisma.message.create({
    data: {
      conversationId: chGpu.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Tuyệt vời Alex! Mình vừa submit lại Slurm job array cho 8x H100 SXM5 trên Node 04. Batch size đặt 64 với FP8 mixed precision.',
      replyToId: gpuMsg1.id,
      createdAt: new Date(Date.now() - 20 * 3600000),
    },
  });

  const gpuMsg3 = await prisma.message.create({
    data: {
      conversationId: chGpu.id,
      senderId: researcherUser.id,
      type: MessageType.text,
      content: 'Watching the nvlink telemetry right now. Average bus utilization is at 88.4%, all-reduce overhead is down to 4.2%!',
      attachments: [
        {
          name: 'h100_cluster_slurm_telemetry.log',
          url: 'https://raw.githubusercontent.com/pytorch/pytorch/master/README.md',
          size: 48200,
          type: 'text/plain',
        },
      ],
      createdAt: new Date(Date.now() - 16 * 3600000),
    },
  });

  const gpuMsg4 = await prisma.message.create({
    data: {
      conversationId: chGpu.id,
      senderId: adminUser.id,
      type: MessageType.text,
      content: 'What is the peak VRAM consumption per GPU during the backward pass compared to our baseline on A100?',
      createdAt: new Date(Date.now() - 10 * 3600000),
    },
  });

  const gpuMsg5 = await prisma.message.create({
    data: {
      conversationId: chGpu.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Dạ peak VRAM chỉ khoảng 46.8 GB / 80 GB nhờ áp dụng FlashAttention-2 và activation checkpointing có chọn lọc, tiết kiệm hơn 35% so với A100 ạ!',
      replyToId: gpuMsg4.id,
      createdAt: new Date(Date.now() - 4 * 3600000),
    },
  });

  const gpuMsg6 = await prisma.message.create({
    data: {
      conversationId: chGpu.id,
      senderId: researcherUser.id,
      type: MessageType.text,
      content: 'At this throughput, 100 epochs will take roughly 14 hours instead of 22 hours. Zero OOM errors.',
      createdAt: new Date(Date.now() - 35 * 60000),
    },
  });

  await prisma.messageReaction.createMany({
    data: [
      { messageId: gpuMsg3.id, userId: userThanh.id, emoji: '🔥', createdAt: new Date(Date.now() - 15 * 3600000) },
      { messageId: gpuMsg5.id, userId: adminUser.id, emoji: '💡', createdAt: new Date(Date.now() - 3 * 3600000) },
      { messageId: gpuMsg6.id, userId: userThanh.id, emoji: '🚀', createdAt: new Date(Date.now() - 20 * 60000) },
    ],
  });

  // 6.3 Channel #paper-drafting
  const chDrafting = await prisma.conversation.create({
    data: {
      type: ConversationType.project_channel,
      name: 'paper-drafting',
      topic: 'LaTeX drafting, Overleaf synchronization, and bibliography citation cross-referencing',
      projectId: project.id,
      isDefault: false,
      createdById: userThanh.id,
      createdAt: new Date(Date.now() - 10 * 86400000),
      lastMessageAt: new Date(Date.now() - 50 * 60000),
      lastSenderName: 'Tấn Thành',
      lastMessageSnippet: 'Dạ em đã chuẩn bị xong bảng thông số hyperparameters và seed numbers ở Table 5 trong phụ lục rồi ạ.',
      members: {
        create: [
          { userId: userThanh.id, role: ConversationMemberRole.owner, lastReadAt: new Date() },
          { userId: researcherUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
          { userId: reviewerUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
          { userId: adminUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
        ],
      },
    },
  });

  const dMsg1 = await prisma.message.create({
    data: {
      conversationId: chDrafting.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Alex ơi, bạn kiểm tra lại phần tham chiếu BibTeX trong Section 3 (Related Works) giúp mình nhé, đặc biệt là các trích dẫn về DeiT và Swin Transformer.',
      createdAt: new Date(Date.now() - 2 * 86400000),
    },
  });

  const dMsg2 = await prisma.message.create({
    data: {
      conversationId: chDrafting.id,
      senderId: researcherUser.id,
      type: MessageType.text,
      content: 'Section 4 (Methodology) equations and Figure 2 vector assets have been merged.',
      attachments: [
        {
          name: 'methodology_architecture_flowchart.pdf',
          url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
          size: 142050,
          type: 'application/pdf',
        },
      ],
      createdAt: new Date(Date.now() - 1 * 86400000),
    },
  });

  const dMsg3 = await prisma.message.create({
    data: {
      conversationId: chDrafting.id,
      senderId: reviewerUser.id,
      type: MessageType.text,
      content: 'Please check equation 14 in Section 4.2. In the two-column ACM/IEEE template, the double summation line was breaking past the column margin.',
      createdAt: new Date(Date.now() - 12 * 3600000),
    },
  });

  const dMsg4 = await prisma.message.create({
    data: {
      conversationId: chDrafting.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Cảm ơn thầy Brody! Em đã dùng môi trường `\\begin{multline}` để bẻ dòng công thức 14 và căn chỉnh lại dấu ngoặc `\\left( ... \\right)`. Margin giờ đã gọn gàng trong 3.3 inches ạ.',
      replyToId: dMsg3.id,
      createdAt: new Date(Date.now() - 6 * 3600000),
    },
  });

  const dMsg5 = await prisma.message.create({
    data: {
      conversationId: chDrafting.id,
      senderId: adminUser.id,
      type: MessageType.text,
      content: "The abstract is punchy and highlights our 3 key contributions clearly. Let's make sure the reproducibility checklist in Appendix A is completed.",
      createdAt: new Date(Date.now() - 2 * 3600000),
    },
  });

  const dMsg6 = await prisma.message.create({
    data: {
      conversationId: chDrafting.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Dạ em đã chuẩn bị xong bảng thông số hyperparameters và seed numbers ở Table 5 trong phụ lục rồi ạ.',
      replyToId: dMsg5.id,
      createdAt: new Date(Date.now() - 50 * 60000),
    },
  });

  await prisma.messageReaction.createMany({
    data: [
      { messageId: dMsg4.id, userId: reviewerUser.id, emoji: '👍', createdAt: new Date(Date.now() - 5 * 3600000) },
      { messageId: dMsg6.id, userId: adminUser.id, emoji: '❤️', createdAt: new Date(Date.now() - 30 * 60000) },
    ],
  });

  // 6.4 Channel #literature-review
  const chLiterature = await prisma.conversation.create({
    data: {
      type: ConversationType.project_channel,
      name: 'literature-review',
      topic: 'Tracking arXiv preprints, SOTA benchmarks on Hugging Face, and Conference deadlines',
      projectId: project.id,
      isDefault: false,
      createdById: userThanh.id,
      createdAt: new Date(Date.now() - 8 * 86400000),
      lastMessageAt: new Date(Date.now() - 2 * 3600000),
      lastSenderName: 'Dr. Evelyn Vance',
      lastMessageSnippet: "Good catch! Let's cite them in the discussion section on computational efficiency.",
      members: {
        create: [
          { userId: userThanh.id, role: ConversationMemberRole.owner, lastReadAt: new Date() },
          { userId: sophiaUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
          { userId: researcherUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
          { userId: adminUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
        ],
      },
    },
  });

  const litMsg1 = await prisma.message.create({
    data: {
      conversationId: chLiterature.id,
      senderId: sophiaUser.id,
      type: MessageType.text,
      content: 'Has anyone checked the new arXiv preprint on Sparse Mixture-of-Experts with dynamic token routing?',
      createdAt: new Date(Date.now() - 10 * 3600000),
    },
  });

  const litMsg2 = await prisma.message.create({
    data: {
      conversationId: chLiterature.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Chào Sophia! Mình vừa đọc sáng nay. Kỹ thuật auxiliary-loss-free load balancing của họ rất đáng học hỏi cho module routing trong Flux.',
      replyToId: litMsg1.id,
      createdAt: new Date(Date.now() - 7 * 3600000),
    },
  });

  const litMsg3 = await prisma.message.create({
    data: {
      conversationId: chLiterature.id,
      senderId: researcherUser.id,
      type: MessageType.text,
      content: "I've added the BibTeX entry to our shared references.bib library and tagged it under #moe-architectures.",
      createdAt: new Date(Date.now() - 4 * 3600000),
    },
  });

  const litMsg4 = await prisma.message.create({
    data: {
      conversationId: chLiterature.id,
      senderId: adminUser.id,
      type: MessageType.text,
      content: "Good catch! Let's cite them in the discussion section on computational efficiency.",
      createdAt: new Date(Date.now() - 2 * 3600000),
    },
  });

  await prisma.messageReaction.createMany({
    data: [
      { messageId: litMsg2.id, userId: sophiaUser.id, emoji: '💡', createdAt: new Date(Date.now() - 6 * 3600000) },
      { messageId: litMsg4.id, userId: userThanh.id, emoji: '👍', createdAt: new Date(Date.now() - 1 * 3600000) },
    ],
  });

  // 7. SEED GROUP CHATS
  console.log('👥 Seeding research group chats...');

  // 7.1 Group 1: Computer Vision & LLM Lab
  const convLabGroup = await prisma.conversation.create({
    data: {
      type: ConversationType.group,
      name: 'Computer Vision & LLM Lab',
      topic: 'Weekly sync on Vision Transformers, Multimodal alignment, and Paper submissions',
      avatar: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
      createdById: userThanh.id,
      createdAt: new Date(Date.now() - 14 * 86400000),
      lastMessageAt: new Date(Date.now() - 1 * 3600000),
      lastSenderName: 'Dr. Evelyn Vance',
      lastMessageSnippet: 'Slides look clean and well-structured! See everyone on Thursday at 2 PM in Room 402.',
      members: {
        create: [
          { userId: userThanh.id, role: ConversationMemberRole.owner, isPinned: true, lastReadAt: new Date() },
          { userId: adminUser.id, role: ConversationMemberRole.admin, lastReadAt: new Date() },
          { userId: researcherUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
          { userId: reviewerUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
          { userId: sophiaUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
        ],
      },
    },
  });

  const g1 = await prisma.message.create({
    data: {
      conversationId: convLabGroup.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Chào cả nhóm! Tuần này mình sẽ trình bày về "Scaling Laws for Vision Transformers" tại buổi Seminar của Khoa vào thứ Năm nhé.',
      createdAt: new Date(Date.now() - 3 * 86400000),
    },
  });

  const g2 = await prisma.message.create({
    data: {
      conversationId: convLabGroup.id,
      senderId: researcherUser.id,
      type: MessageType.text,
      content: 'Awesome topic! I will prepare the benchmark comparison graphs on ImageNet-1K and ImageNet-A to accompany the talk.',
      createdAt: new Date(Date.now() - 2 * 86400000),
    },
  });

  const g3 = await prisma.message.create({
    data: {
      conversationId: convLabGroup.id,
      senderId: sophiaUser.id,
      type: MessageType.text,
      content: 'I can also share our initial probing experiments on attention maps across deeper transformer blocks.',
      createdAt: new Date(Date.now() - 1 * 86400000),
    },
  });

  const g4 = await prisma.message.create({
    data: {
      conversationId: convLabGroup.id,
      senderId: reviewerUser.id,
      type: MessageType.text,
      content: 'Make sure to include confidence intervals for the top-1 accuracy deltas, especially for fine-tuned checkpoints.',
      createdAt: new Date(Date.now() - 14 * 3600000),
    },
  });

  const g5 = await prisma.message.create({
    data: {
      conversationId: convLabGroup.id,
      senderId: adminUser.id,
      type: MessageType.text,
      content: 'Reminder: Lab seminar slides are due tomorrow 5 PM. Please upload to Drive.',
      createdAt: new Date(Date.now() - 6 * 3600000),
    },
  });

  const g6 = await prisma.message.create({
    data: {
      conversationId: convLabGroup.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Dạ em vừa upload bản thảo slide Seminar_Scaling_Laws_ViT_v2.pdf lên thư mục Presentations rồi cô nhé!',
      attachments: [
        {
          name: 'Seminar_Scaling_Laws_ViT_v2.pdf',
          url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
          size: 3420000,
          type: 'application/pdf',
        },
      ],
      replyToId: g5.id,
      createdAt: new Date(Date.now() - 2 * 3600000),
    },
  });

  const g7 = await prisma.message.create({
    data: {
      conversationId: convLabGroup.id,
      senderId: adminUser.id,
      type: MessageType.text,
      content: 'Slides look clean and well-structured! See everyone on Thursday at 2 PM in Room 402.',
      createdAt: new Date(Date.now() - 1 * 3600000),
    },
  });

  await prisma.messageReaction.createMany({
    data: [
      { messageId: g1.id, userId: adminUser.id, emoji: '👏', createdAt: new Date(Date.now() - 3 * 86400000 + 3600000) },
      { messageId: g1.id, userId: researcherUser.id, emoji: '🎉', createdAt: new Date(Date.now() - 3 * 86400000 + 7200000) },
      { messageId: g6.id, userId: adminUser.id, emoji: '👍', createdAt: new Date(Date.now() - 90 * 60000) },
      { messageId: g7.id, userId: userThanh.id, emoji: '❤️', createdAt: new Date(Date.now() - 40 * 60000) },
    ],
  });

  // 7.2 Group 2: NeurIPS 2026 Camera-Ready Sprint
  const convSprintGroup = await prisma.conversation.create({
    data: {
      type: ConversationType.group,
      name: 'NeurIPS 2026 Submission Sprint',
      topic: 'Final sprint for NeurIPS 2026 submissions, reproducibility checklists, and supplementary code',
      avatar: 'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=150',
      createdById: userThanh.id,
      createdAt: new Date(Date.now() - 7 * 86400000),
      lastMessageAt: new Date(Date.now() - 20 * 60000),
      lastSenderName: 'Tấn Thành',
      lastMessageSnippet: 'Em đã nộp bản PDF camera-ready lên OpenReview portal thành công và nhận được confirmation receipt rồi ạ!',
      members: {
        create: [
          { userId: userThanh.id, role: ConversationMemberRole.owner, isPinned: false, lastReadAt: new Date() },
          { userId: adminUser.id, role: ConversationMemberRole.admin, lastReadAt: new Date() },
          { userId: researcherUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
          { userId: reviewerUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
        ],
      },
    },
  });

  const sp1 = await prisma.message.create({
    data: {
      conversationId: convSprintGroup.id,
      senderId: adminUser.id,
      type: MessageType.text,
      content: 'Team, we have 48 hours left until the final camera-ready deadline. Let’s do a final checklist review.',
      createdAt: new Date(Date.now() - 18 * 3600000),
    },
  });

  const sp2 = await prisma.message.create({
    data: {
      conversationId: convSprintGroup.id,
      senderId: researcherUser.id,
      type: MessageType.text,
      content: 'Supplementary zip package verified: PyTorch scripts, conda environment.yml, and random seed test configs are bundled cleanly.',
      createdAt: new Date(Date.now() - 10 * 3600000),
    },
  });

  const sp3 = await prisma.message.create({
    data: {
      conversationId: convSprintGroup.id,
      senderId: reviewerUser.id,
      type: MessageType.text,
      content: 'Checked the license headers and author affiliations on page 1. Everything strictly follows the official author formatting instructions.',
      createdAt: new Date(Date.now() - 4 * 3600000),
    },
  });

  const sp4 = await prisma.message.create({
    data: {
      conversationId: convSprintGroup.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Em đã nộp bản PDF camera-ready lên OpenReview portal thành công và nhận được confirmation receipt rồi ạ!',
      createdAt: new Date(Date.now() - 20 * 60000),
    },
  });

  await prisma.messageReaction.createMany({
    data: [
      { messageId: sp2.id, userId: adminUser.id, emoji: '🚀', createdAt: new Date(Date.now() - 9 * 3600000) },
      { messageId: sp3.id, userId: userThanh.id, emoji: '✅', createdAt: new Date(Date.now() - 3 * 3600000) },
      { messageId: sp4.id, userId: adminUser.id, emoji: '🎉', createdAt: new Date(Date.now() - 15 * 60000) },
      { messageId: sp4.id, userId: researcherUser.id, emoji: '🔥', createdAt: new Date(Date.now() - 12 * 60000) },
    ],
  });

  // 8. SEED DIRECT MESSAGES (1-1)
  console.log('💬 Seeding direct 1-1 conversations...');

  // 8.1 Direct 1: Alex Chen (Senior ML Research Engineer) - has 1 unread message!
  const convAlex = await prisma.conversation.create({
    data: {
      type: ConversationType.direct,
      createdById: researcherUser.id,
      createdAt: new Date(Date.now() - 5 * 86400000),
      lastMessageAt: new Date(Date.now() - 12 * 60000), // 12 mins ago
      lastSenderName: 'Alex Chen',
      lastMessageSnippet: 'Check the new FlashAttention-2 benchmarks in experiment_matrix_v3.xlsx. Latency dropped by 28%!',
      members: {
        create: [
          {
            userId: userThanh.id,
            role: ConversationMemberRole.member,
            lastReadAt: new Date(Date.now() - 20 * 60000), // 1 unread message!
            isPinned: true,
          },
          {
            userId: researcherUser.id,
            role: ConversationMemberRole.member,
            lastReadAt: new Date(),
          },
        ],
      },
    },
  });

  const aMsg1 = await prisma.message.create({
    data: {
      conversationId: convAlex.id,
      senderId: researcherUser.id,
      type: MessageType.text,
      content: 'Hey Thành! Did you push the updated patch embedding dimensions for the ViT-Large backbone?',
      createdAt: new Date(Date.now() - 2 * 86400000),
    },
  });

  const aMsg2 = await prisma.message.create({
    data: {
      conversationId: convAlex.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Rồi Alex ơi! Mình vừa cập nhật file vit_large_pretraining_config.yaml lên Drive. Mình set patch_size=16, embed_dim=1024, num_heads=16 và dùng CosineAnnealingLR với 10k steps warmup nhé.',
      attachments: [
        {
          name: 'vit_large_pretraining_config.yaml',
          url: 'https://raw.githubusercontent.com/yaml/yaml/master/README.md',
          size: 14640,
          type: 'application/x-yaml',
        },
      ],
      createdAt: new Date(Date.now() - 1 * 86400000),
    },
  });

  const aMsg3 = await prisma.message.create({
    data: {
      conversationId: convAlex.id,
      senderId: researcherUser.id,
      type: MessageType.text,
      content: 'Check the new FlashAttention-2 benchmarks in experiment_matrix_v3.xlsx. Latency dropped by 28%!',
      createdAt: new Date(Date.now() - 12 * 60000),
    },
  });

  await prisma.messageReaction.createMany({
    data: [
      { messageId: aMsg2.id, userId: researcherUser.id, emoji: '🔥', createdAt: new Date(Date.now() - 1 * 86400000 + 3600000) },
    ],
  });

  // 8.2 Direct 2: Dr. Evelyn Vance (Lab Director)
  const convVance = await prisma.conversation.create({
    data: {
      type: ConversationType.direct,
      createdById: userThanh.id,
      createdAt: new Date(Date.now() - 6 * 86400000),
      lastMessageAt: new Date(Date.now() - 45 * 60000),
      lastSenderName: 'Tấn Thành',
      lastMessageSnippet: 'Dạ vâng cô, em cảm ơn cô nhiều ạ! Em sẽ nộp hồ sơ grant ngay trong chiều nay.',
      members: {
        create: [
          {
            userId: userThanh.id,
            role: ConversationMemberRole.member,
            lastReadAt: new Date(),
            isPinned: true,
          },
          {
            userId: adminUser.id,
            role: ConversationMemberRole.member,
            lastReadAt: new Date(),
          },
        ],
      },
    },
  });

  const vMsg1 = await prisma.message.create({
    data: {
      conversationId: convVance.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Chào cô Evelyn, em đã cập nhật lại bảng phân bổ GPU cluster trong đề cương nghiên cứu (research_proposal_2026.pdf) theo yêu cầu hôm thứ Hai ạ.',
      createdAt: new Date(Date.now() - 3 * 86400000),
    },
  });

  const vMsg2 = await prisma.message.create({
    data: {
      conversationId: convVance.id,
      senderId: adminUser.id,
      type: MessageType.text,
      content: 'Great work, Thành! Are we using 8 nodes x 8 H100 for the 300-epoch pretraining run, or are we scaling to 16 nodes with Slurm job arrays?',
      createdAt: new Date(Date.now() - 2 * 86400000),
    },
  });

  const vMsg3 = await prisma.message.create({
    data: {
      conversationId: convVance.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Em đã thử nghiệm với Slurm DDP trên 8 node trước. Kết quả đo đạc cho thấy NCCL ring-allreduce đạt 91% linear scaling efficiency khi bật FP8 mixed-precision. Em đã đính kèm script run_distributed_ddp_slurm.sh trong thư mục Checkpoints của Drive ạ.',
      replyToId: vMsg2.id,
      createdAt: new Date(Date.now() - 1 * 86400000),
    },
  });

  const vMsg4 = await prisma.message.create({
    data: {
      conversationId: convVance.id,
      senderId: adminUser.id,
      type: MessageType.text,
      content: "I've reviewed the latest grant section—the throughput numbers on H100 look solid. Go ahead and submit.",
      createdAt: new Date(Date.now() - 2 * 3600000),
    },
  });

  const vMsg5 = await prisma.message.create({
    data: {
      conversationId: convVance.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Dạ vâng cô, em cảm ơn cô nhiều ạ! Em sẽ nộp hồ sơ grant ngay trong chiều nay.',
      replyToId: vMsg4.id,
      createdAt: new Date(Date.now() - 45 * 60000),
    },
  });

  await prisma.messageReaction.createMany({
    data: [
      { messageId: vMsg1.id, userId: adminUser.id, emoji: '👍', createdAt: new Date(Date.now() - 3 * 86400000 + 3600000) },
      { messageId: vMsg3.id, userId: adminUser.id, emoji: '🚀', createdAt: new Date(Date.now() - 1 * 86400000 + 1800000) },
      { messageId: vMsg4.id, userId: userThanh.id, emoji: '❤️', createdAt: new Date(Date.now() - 1 * 3600000) },
      { messageId: vMsg5.id, userId: adminUser.id, emoji: '👍', createdAt: new Date(Date.now() - 30 * 60000) },
    ],
  });

  // 8.3 Direct 3: Dr. Marcus Brody (Senior Statistician & Reviewer)
  const convBrody = await prisma.conversation.create({
    data: {
      type: ConversationType.direct,
      createdById: reviewerUser.id,
      createdAt: new Date(Date.now() - 8 * 86400000),
      lastMessageAt: new Date(Date.now() - 5 * 3600000),
      lastSenderName: 'Dr. Marcus Brody',
      lastMessageSnippet: 'The statistical significance p-value tests look robust. Ready for camera-ready.',
      members: {
        create: [
          { userId: userThanh.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
          { userId: reviewerUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
        ],
      },
    },
  });

  const bMsg1 = await prisma.message.create({
    data: {
      conversationId: convBrody.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Dear Dr. Brody, I have incorporated your recommendations on bootstrapping confidence intervals into Table 3 of the manuscript.',
      createdAt: new Date(Date.now() - 2 * 86400000),
    },
  });

  const bMsg2 = await prisma.message.create({
    data: {
      conversationId: convBrody.id,
      senderId: reviewerUser.id,
      type: MessageType.text,
      content: 'The statistical significance p-value tests look robust. Ready for camera-ready.',
      createdAt: new Date(Date.now() - 1 * 86400000),
    },
  });

  const bMsg3 = await prisma.message.create({
    data: {
      conversationId: convBrody.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Thank you Dr. Brody! I also added the Wilcoxon signed-rank test results in Table 4 for the ablation study comparison.',
      createdAt: new Date(Date.now() - 8 * 3600000),
    },
  });

  const bMsg4 = await prisma.message.create({
    data: {
      conversationId: convBrody.id,
      senderId: reviewerUser.id,
      type: MessageType.text,
      content: 'Excellent. That will satisfy any potential reviewer objections regarding non-normal sample distribution assumptions.',
      createdAt: new Date(Date.now() - 5 * 3600000),
    },
  });

  await prisma.messageReaction.createMany({
    data: [
      { messageId: bMsg2.id, userId: userThanh.id, emoji: '❤️', createdAt: new Date(Date.now() - 22 * 3600000) },
      { messageId: bMsg4.id, userId: userThanh.id, emoji: '👍', createdAt: new Date(Date.now() - 4 * 3600000) },
    ],
  });

  // 8.4 Direct 4: Dr. Sophia Lin (Postdoc Fellow in Multimodal Alignment)
  const convSophia = await prisma.conversation.create({
    data: {
      type: ConversationType.direct,
      createdById: sophiaUser.id,
      createdAt: new Date(Date.now() - 4 * 86400000),
      lastMessageAt: new Date(Date.now() - 2 * 3600000),
      lastSenderName: 'Tấn Thành',
      lastMessageSnippet: 'Biểu đồ cross-attention alignment rất trực quan! Mình sẽ đưa biểu đồ này vào Figure 4 của bài báo nhé.',
      members: {
        create: [
          { userId: userThanh.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
          { userId: sophiaUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
        ],
      },
    },
  });

  const sMsg1 = await prisma.message.create({
    data: {
      conversationId: convSophia.id,
      senderId: sophiaUser.id,
      type: MessageType.text,
      content: 'Hi Thành, did you notice that the text-image contrastive loss converges faster when we apply temperature scaling with tau = 0.07?',
      createdAt: new Date(Date.now() - 16 * 3600000),
    },
  });

  const sMsg2 = await prisma.message.create({
    data: {
      conversationId: convSophia.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Chào Sophia! Đúng vậy, mình cũng quan sát thấy điều đó trên dataset CC3M. Nếu để nhiệt độ lớn hơn thì softmax gradient bị bão hòa sớm.',
      replyToId: sMsg1.id,
      createdAt: new Date(Date.now() - 8 * 3600000),
    },
  });

  const sMsg3 = await prisma.message.create({
    data: {
      conversationId: convSophia.id,
      senderId: sophiaUser.id,
      type: MessageType.text,
      content: 'I generated cross-attention heatmaps showing token activation patterns. The visual alignment on fine-grained object boundaries is remarkably sharp!',
      attachments: [
        {
          name: 'cross_attention_alignment_heatmap.png',
          url: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800',
          size: 684200,
          type: 'image/png',
        },
      ],
      createdAt: new Date(Date.now() - 4 * 3600000),
    },
  });

  const sMsg4 = await prisma.message.create({
    data: {
      conversationId: convSophia.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Biểu đồ cross-attention alignment rất trực quan! Mình sẽ đưa biểu đồ này vào Figure 4 của bài báo nhé.',
      replyToId: sMsg3.id,
      createdAt: new Date(Date.now() - 2 * 3600000),
    },
  });

  await prisma.messageReaction.createMany({
    data: [
      { messageId: sMsg3.id, userId: userThanh.id, emoji: '🔥', createdAt: new Date(Date.now() - 3 * 3600000) },
      { messageId: sMsg4.id, userId: sophiaUser.id, emoji: '❤️', createdAt: new Date(Date.now() - 90 * 60000) },
    ],
  });

  console.log('✅ All Project Channels, Groups, Direct Chats, Messages, and Reactions seeded successfully.');

  // 9. REDIS CACHE INVALIDATION
  if (redis) {
    try {
      console.log('🔄 Connecting to Redis to invalidate stale chat cache...');
      await redis.connect();
      const keys = await redis.keys('chat:*');
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`🧹 Invalidation complete: Cleared ${keys.length} Redis chat cache keys.`);
      }
      redis.disconnect();
    } catch (err) {
      console.warn('⚠️ Redis cache invalidation skipped:', (err as Error).message);
    }
  }

  console.log('🎉 Realistic Chat demo data seeding completed successfully!');
}

run()
  .catch((e) => {
    console.error('❌ Seeding failed with error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
