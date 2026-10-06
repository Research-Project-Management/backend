import 'dotenv/config';
import { Pool } from 'pg';
import {
  PrismaClient,
  EntityType,
  AuditOutcome,
  AuditSeverity,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://postgres:Thanh26102006@localhost:5433/flux-db?schema=public',
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const API_BASE = 'http://localhost:3000';

interface StepResult {
  step: string;
  name: string;
  status: 'SUCCESS' | 'WARNING' | 'ERROR';
  details: string;
  error?: string;
}

const results: StepResult[] = [];

async function logStep(step: string, name: string, fn: () => Promise<string>) {
  process.stdout.write(`⏳ [${step}] ${name}... `);
  try {
    const details = await fn();
    console.log(`✅ OK`);
    results.push({ step, name, status: 'SUCCESS', details });
  } catch (err: any) {
    console.log(`❌ ERROR: ${err?.message || err}`);
    results.push({
      step,
      name,
      status: 'ERROR',
      details: 'Failed to complete step',
      error: err?.message || String(err),
    });
  }
}

async function runResearcherJourney() {
  console.log(
    '================================================================================',
  );
  console.log(
    '🔬 GS. TS. NGÔ TẤN THÀNH - END-TO-END RESEARCH LIFECYCLE WORKFLOW',
  );
  console.log(
    '   Testing all system capabilities across all modules with real academic context',
  );
  console.log(
    '================================================================================\n',
  );

  let token = '';
  let userId = '';
  let projectFluxId = '';
  let flashAttentionItemId = '';
  let wi12Id = '';
  let docMainId = '';
  let commentThreadId = '';

  // --------------------------------------------------------------------------
  // STEP 1: AUTHENTICATION & IDENTITY
  // --------------------------------------------------------------------------
  await logStep(
    'AUTH',
    'Login with GS. TS. Ngô Tấn Thành credentials',
    async () => {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'ngotanthanh92.26@gmail.com',
          password: 'Password123!',
        }),
      });
      if (!res.ok) {
        throw new Error(
          `Login failed with status ${res.status}: ${await res.text()}`,
        );
      }
      const json = (await res.json()) as any;
      token = json.data?.accessToken || json.accessToken;
      userId = json.data?.user?.id || json.user?.id;
      if (!token) throw new Error('No access token returned');
      return `Logged in as ${json.data?.user?.name || 'GS. TS. Ngô Tấn Thành'} (${userId})`;
    },
  );

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // --------------------------------------------------------------------------
  // STEP 2: PROFILE & USER SETTINGS VERIFICATION
  // --------------------------------------------------------------------------
  await logStep(
    'IDENTITY',
    'Verify Profile, Institution & Editor Configuration',
    async () => {
      const profile = await prisma.userProfile.findUnique({
        where: { userId },
      });
      const settings = await prisma.userSettings.findUnique({
        where: { userId },
      });
      if (!profile) throw new Error('User profile not found');
      return `Profile: ${profile.name} | Institution: ${profile.institution} | Locale: ${settings?.locale}`;
    },
  );

  // --------------------------------------------------------------------------
  // STEP 3: WORKSPACE & PROJECT DISCOVERY
  // --------------------------------------------------------------------------
  await logStep(
    'PROJECTS',
    'Load active research projects and status updates',
    async () => {
      const res = await fetch(`${API_BASE}/api/projects`, {
        headers: authHeaders,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as any;
      const projectList =
        json.data?.projects ||
        json.data?.myProjects ||
        (Array.isArray(json.data) ? json.data : []);
      const flux = projectList.find(
        (p: any) =>
          p.identifier?.toLowerCase() === 'flux' ||
          p.name?.toLowerCase() === 'flux',
      );
      if (!flux) throw new Error('Project FLUX not found in projects listing');
      projectFluxId = flux.id;

      // Check updates
      const updates = await prisma.projectUpdate.findMany({
        where: { projectId: projectFluxId },
        orderBy: { createdAt: 'desc' },
        take: 2,
      });
      return `Project FLUX (${projectFluxId}) resolved | Found ${projectList.length} projects | Latest update: "${updates[0]?.message.slice(0, 60)}..."`;
    },
  );

  // --------------------------------------------------------------------------
  // STEP 4: LIBRARY & LITERATURE DISCOVERY
  // --------------------------------------------------------------------------
  await logStep(
    'LIBRARY',
    'Search literature catalog for FlashAttention and Adam papers',
    async () => {
      const papers = await prisma.item.findMany({
        where: {
          OR: [
            { title: { contains: 'FlashAttention' } },
            { title: { contains: 'Adam' } },
          ],
        },
        include: {
          contributors: true,
          collectionItems: true,
        },
      });
      if (papers.length === 0)
        throw new Error('No target papers found in library');
      const flashPaper = papers.find((p) => p.title.includes('FlashAttention'));
      if (!flashPaper) throw new Error('FlashAttention paper not found');
      flashAttentionItemId = flashPaper.id;

      return `Found ${papers.length} landmark papers | Selected "${flashPaper.title}" (${flashPaper.doi || 'No DOI'})`;
    },
  );

  // --------------------------------------------------------------------------
  // STEP 5: ADD RESEARCH READING NOTE WITH LATEX MATH
  // --------------------------------------------------------------------------
  await logStep(
    'NOTE',
    'Record mathematical insight note on FlashAttention-2',
    async () => {
      if (!flashAttentionItemId)
        throw new Error('flashAttentionItemId not set');
      const note = await prisma.note.create({
        data: {
          itemId: flashAttentionItemId,
          userId,
          title: 'Tối ưu hóa Băng thông SRAM và Phân chia Khối GPU Hopper',
          contentMd: `### Phân tích Tiling và Asynchronous TMA\n\nĐối với kiến trúc Hopper H100 (SM90a), phép toán Attention chia tile theo kích thước:\n\n$$B_r = 128, \\quad B_c = 128$$\n\nSử dụng lệnh nạp khối bất đồng bộ \`cp.async.bulk.tensor\` qua Tensor Memory Accelerator (TMA) loại bỏ hoàn toàn sự can thiệp của ALU luồng, đưa hiệu suất đạt 74.2% peak theoretical FP16 FLOPS.\n\n$$\\text{Speedup} = \\frac{\\text{Standard PyTorch SDPA}}{\\text{FlashAttention-2}} \\approx 2.45\\times$$`,
        },
      });

      // Update reading state to 5 stars, finished reading
      await prisma.state.upsert({
        where: {
          userId_itemId: {
            userId,
            itemId: flashAttentionItemId,
          },
        },
        create: {
          userId,
          itemId: flashAttentionItemId,
          rating: 5,
          readStatus: 'completed',
          isStarred: true,
          currentPage: 18,
          lastOpenedAt: new Date(),
        },
        update: {
          rating: 5,
          readStatus: 'completed',
          isStarred: true,
          currentPage: 18,
          lastOpenedAt: new Date(),
        },
      });

      return `Created research note ID ${note.id} with LaTeX formulas & set 5-star reading state`;
    },
  );

  // --------------------------------------------------------------------------
  // STEP 6: WORK ITEM PROGRESSION & COLLABORATIVE COMMENT (LINKING PAPER TO TASK)
  // --------------------------------------------------------------------------
  await logStep(
    'WORK-ITEM',
    'Advance FLUX-12 to In-Progress and post benchmark discussion',
    async () => {
      if (!projectFluxId) throw new Error('projectFluxId not set');
      const wi12 = await prisma.workItem.findFirst({
        where: { projectId: projectFluxId, sequenceNumber: 12 },
      });
      if (!wi12) throw new Error('Work item FLUX-12 not found');
      wi12Id = wi12.id;

      // Transition column to in_progress
      await prisma.workItem.update({
        where: { id: wi12.id },
        data: {
          columnId: 'in_progress',
          timeSpent: 8.5,
        },
      });

      // Post comment referencing FlashAttention-2 benchmark on 8x H100
      const comment = await prisma.workItemComment.create({
        data: {
          workItemId: wi12.id,
          authorId: userId,
          content: `Đã hoàn thành tích hợp FlashAttention-2 vào benchmark suite. Kết quả thử nghiệm trên cụm 8x H100 SXM5:\n\n- Throughput: 3,450 tokens/giây/GPU (tăng 2.45x so với PyTorch SDPA)\n- VRAM peak: 24.2 GB / 80 GB (giảm 58% dung lượng nhớ đệm)\n- Trích dẫn thư viện đã liên kết: [dao2023flashattention2]`,
        },
      });

      // Post project update on FLUX timeline
      await prisma.projectUpdate.create({
        data: {
          projectId: projectFluxId,
          createdById: userId,
          status: 'on_track',
          message:
            'Hoàn thành tích hợp và đánh giá hiệu năng FlashAttention-2 trên cụm 8x H100 SXM5 cho bản thảo ICLR 2026.',
        },
      });

      return `Work item FLUX-12 moved to "in_progress" | Posted comment ID ${comment.id} & Project Update`;
    },
  );

  // --------------------------------------------------------------------------
  // STEP 7: ENTERPRISE STORAGE EXPERIMENT ARTIFACT
  // --------------------------------------------------------------------------
  await logStep(
    'STORAGE',
    'Register experimental evaluation benchmark artifact in Cloud Storage',
    async () => {
      // Find Datasets folder
      const datasetsFolder = await prisma.file.findFirst({
        where: {
          authorId: userId,
          isFolder: true,
          filename: { contains: 'Datasets' },
        },
      });

      const artifactFile = await prisma.file.create({
        data: {
          filename: 'h100_flashattention2_profiling_results.json',
          size: BigInt(248500),
          mimeType: 'application/json',
          url: 'https://storage.rpm.local/benchmarks/h100_flashattention2_profiling_results.json',
          parentId: datasetsFolder?.id || null,
          linkedToType: 'project',
          linkedToId: projectFluxId,
          authorId: userId,
          starred: true,
          metaData: {
            gpu: 'NVIDIA H100 SXM5 80GB',
            numNodes: 1,
            numGpus: 8,
            seqLen: 32768,
            tflops: 685.4,
            speedupVsBaseline: 2.45,
            timestamp: new Date().toISOString(),
          },
        },
      });

      // Share with research fellow Alex Chen
      const alexUser = await prisma.user.findFirst({
        where: { email: 'researcher@rpm.local' },
      });
      if (alexUser) {
        await prisma.fileShare.upsert({
          where: {
            fileId_userId: {
              fileId: artifactFile.id,
              userId: alexUser.id,
            },
          },
          create: {
            fileId: artifactFile.id,
            userId: alexUser.id,
            permission: 'view',
          },
          update: {},
        });
      }

      return `Registered artifact "${artifactFile.filename}" (248 KB, Starred ⭐) & shared with Alex Chen`;
    },
  );

  // --------------------------------------------------------------------------
  // STEP 8: AI COPILOT ACADEMIC CONSULTATION
  // --------------------------------------------------------------------------
  await logStep(
    'AI-COPILOT',
    'Consult AI Assistant on Section 4 Comparative Discussion',
    async () => {
      // Find existing chat on FlashAttention or create new
      let chat = await prisma.aiChat.findFirst({
        where: { userId, title: { contains: 'FlashAttention' } },
      });
      if (!chat) {
        chat = await prisma.aiChat.create({
          data: {
            userId,
            projectId: projectFluxId,
            title:
              'Tổng hợp so sánh MHA, GQA và FlashAttention-2 cho Section 4',
            summary:
              'So sánh cơ chế truy cập bộ nhớ và thông lượng tính toán phục vụ viết phần Discussion.',
          },
        });
      }

      // Add researcher query
      await prisma.aiMessage.create({
        data: {
          chatId: chat.id,
          role: 'user',
          content:
            'Dựa trên kết quả đo đạc thực tế 3,450 tokens/s trên 8x H100, hãy đề xuất 3 luận điểm khoa học sắc bén so sánh giữa FlashAttention-2 và GQA-8 để đưa vào Mục 4 của bản thảo ICLR.',
        },
      });

      // Add assistant response
      await prisma.aiMessage.create({
        data: {
          chatId: chat.id,
          role: 'assistant',
          content: `Dưới đây là 3 luận điểm cốt lõi thích hợp cho Mục 4 (Discussion & Empirical Analysis):\n\n1. **Tính bổ trợ trực giao (Orthogonal Orthogonality)**: GQA-8 giảm lượng dữ liệu đọc từ HBM thông qua việc chia sẻ key/value heads, trong khi FlashAttention-2 tối ưu hóa việc phân chia bộ nhớ đệm SRAM trên mỗi head. Khi kết hợp cả hai, thông lượng đạt cực đại vì băng thông bộ nhớ và tensor core được bão hòa đồng thời.\n2. **Triệt tiêu hiện tượng thắt cổ chai I/O ở chuỗi dài ($L \\ge 32k$)**: Với context length $32,768$, độ phức tạp bộ nhớ của Standard Attention là $\\mathcal{O}(N^2)$, gây tràn bộ nhớ HBM. FlashAttention-2 giới hạn dung lượng bộ nhớ trung gian ở mức $\\mathcal{O}(N)$, giúp tận dụng tối đa 80GB VRAM của H100 mà không cần checkpointing.\n3. **Cân bằng tải Work Partitioning giữa các Thread Block**: FlashAttention-2 phân bổ công việc theo chiều chuỗi truy vấn (query dimension) thay vì chỉ theo batch size, đảm bảo 132 SM của GPU H100 luôn đạt trạng thái 100% occupancy ngay cả với batch size nhỏ trong quá trình suy luận.`,
          sources: [
            {
              title:
                'FlashAttention-2: Faster Attention with Better Parallelism',
              key: 'dao2023flashattention2',
            },
            { title: 'Attention Is All You Need', key: 'vaswani2017attention' },
          ],
        },
      });

      return `AI Chat "${chat.title}" updated with 2 messages | Recorded 3 rigorous academic arguments`;
    },
  );

  // --------------------------------------------------------------------------
  // STEP 9: LATEX MANUSCRIPTS COLLABORATIVE REVIEW & EDITING
  // --------------------------------------------------------------------------
  await logStep(
    'MANUSCRIPTS',
    'Resolve peer review comments and accept collaborator track changes',
    async () => {
      if (!projectFluxId) throw new Error('projectFluxId not set');
      // Locate target doc (main.tex)
      const docNode = await prisma.manuscriptNode.findFirst({
        where: {
          projectId: projectFluxId,
          type: 'DOC',
          path: { contains: 'main.tex' },
        },
      });
      if (!docNode?.docId) throw new Error('main.tex document node not found');
      docMainId = docNode.docId;

      // Find open comment thread
      const openThread = await prisma.manuscriptCommentThread.findFirst({
        where: { projectId: projectFluxId, isResolved: false },
      });

      if (openThread) {
        commentThreadId = openThread.id;
        // Add author response resolving the thread
        await prisma.manuscriptCommentReply.create({
          data: {
            threadId: openThread.id,
            content:
              'Đã hoàn thiện cập nhật Giả định 2.1 và bổ sung chứng minh Bổ đề 3 trong Phụ lục A. Thread đã được giải quyết triệt để.',
            createdById: userId,
          },
        });

        await prisma.manuscriptCommentThread.update({
          where: { id: openThread.id },
          data: {
            isResolved: true,
            resolvedById: userId,
            resolvedAt: new Date(),
          },
        });
      }

      // Accept pending track changes
      const pendingChanges = await prisma.manuscriptTrackChange.findMany({
        where: { projectId: projectFluxId, status: 'pending' },
      });

      for (const change of pendingChanges) {
        await prisma.manuscriptTrackChange.update({
          where: { id: change.id },
          data: {
            status: 'accepted',
            resolvedById: userId,
            resolvedAt: new Date(),
          },
        });
      }

      // Create a new Git-like version snapshot: v3.1-Pre-Final
      const currentSnapshots = await prisma.manuscriptSnapshot.findMany({
        where: { projectId: projectFluxId },
        orderBy: { version: 'desc' },
      });
      const nextVer = (currentSnapshots[0]?.version || 0) + 1;

      const newSnapshot = await prisma.manuscriptSnapshot.create({
        data: {
          projectId: projectFluxId,
          version: nextVer,
          summary:
            'Bản thảo hoàn thiện sau khi rà soát Bổ đề 2, tích hợp kết quả FlashAttention-2 và số liệu 8x H100',
          createdById: userId,
          sizeBytes: 412000,
          createdAt: new Date(),
        },
      });

      await prisma.manuscriptLabel.create({
        data: {
          projectId: projectFluxId,
          snapshotId: newSnapshot.id,
          version: nextVer,
          label: `v3.${nextVer - 2}-Pre-Final`,
          createdById: userId,
        },
      });

      return `Resolved comment thread ID ${commentThreadId || 'N/A'} | Accepted ${pendingChanges.length} track changes | Tagged snapshot v3.${nextVer - 2}-Pre-Final`;
    },
  );

  // --------------------------------------------------------------------------
  // STEP 10: INBOX, NOTIFICATIONS & CANVAS STICKIES
  // --------------------------------------------------------------------------
  await logStep(
    'INBOX-STICKIES',
    'Review collaborative inbox and update sprint sticky checklist',
    async () => {
      // Mark an unread notification as read
      const unreadNotification = await prisma.manuscriptNotification.findFirst({
        where: { userId, isRead: false },
      });

      if (unreadNotification) {
        await prisma.manuscriptNotification.update({
          where: { id: unreadNotification.id },
          data: { isRead: true, readAt: new Date() },
        });
      }

      // Create a new sticky note on canvas
      const checklistSticky = await prisma.sticky.create({
        data: {
          userId,
          title: 'Hồ sơ Nộp ICLR 2026 - Kiểm tra lần cuối',
          content:
            '1. Định lý 1: Đã rà soát hằng số Lipschitz L và Bổ đề 3 trong Phụ lục A.\n2. Thực nghiệm: Tích hợp FlashAttention-2 tăng tốc 2.45x trên 8x H100 SXM5.\n3. Thư mục trích dẫn: Đã đồng bộ 45 tài liệu chuẩn Zotero vào references.bib.\n4. Phiên bản: Đã gắn tag v3.1-Pre-Final.',
          color: 'emerald-1',
          positionX: 640,
          positionY: 340,
          order: 6,
        },
      });

      return `Marked notification as read | Created new action sticky ID ${checklistSticky.id} ("Hồ sơ Nộp ICLR 2026")`;
    },
  );

  // --------------------------------------------------------------------------
  // STEP 11: THIRD-PARTY INTEGRATION SYNCHRONIZATION
  // --------------------------------------------------------------------------
  await logStep(
    'INTEGRATIONS',
    'Trigger sync status update for Zotero and ORCID identifiers',
    async () => {
      const zoteroInt = await prisma.userIntegration.findFirst({
        where: { userId, provider: 'zotero' },
      });
      if (zoteroInt) {
        await prisma.userIntegration.update({
          where: { id: zoteroInt.id },
          data: {
            lastSyncedAt: new Date(),
            metadata: {
              ...(typeof zoteroInt.metadata === 'object' &&
              zoteroInt.metadata !== null
                ? zoteroInt.metadata
                : {}),
              totalItems: 20,
              lastSyncStatus: 'OK (Synchronized with FLUX references.bib)',
            },
          },
        });
      }

      const orcidInt = await prisma.userIntegration.findFirst({
        where: { userId, provider: 'orcid' },
      });

      return `Zotero sync timestamp refreshed to current time | ORCID (${orcidInt?.providerUserId || '0000-0002-1825-0097'}) verified`;
    },
  );

  // --------------------------------------------------------------------------
  // STEP 12: AUDIT LOGGING & ACTIVITY STREAM
  // --------------------------------------------------------------------------
  await logStep(
    'AUDIT',
    'Record complete research session events in Activity Stream & Audit Log',
    async () => {
      if (!wi12Id || !flashAttentionItemId) {
        throw new Error(
          `Invalid IDs: wi12Id=${wi12Id}, flashAttentionItemId=${flashAttentionItemId}`,
        );
      }
      await prisma.activityEvent.createMany({
        data: [
          {
            entityType: EntityType.work_item,
            entityId: wi12Id,
            verb: 'completed_milestone',
            newValue:
              'Tích hợp thành công FlashAttention-2 trên cụm 8x H100 SXM5',
            actorId: userId,
            projectId: projectFluxId,
          },
          {
            entityType: EntityType.paper,
            entityId: flashAttentionItemId,
            verb: 'annotated_proof',
            newValue:
              'Đã bổ sung ghi chú toán học về Tiling và TMA Asynchronous Barrier',
            actorId: userId,
            projectId: projectFluxId,
          },
        ],
      });

      await prisma.auditLog.create({
        data: {
          actorId: userId,
          action: 'research.session.full_lifecycle_completed',
          outcome: AuditOutcome.success,
          severity: AuditSeverity.info,
          projectId: projectFluxId,
          metadata: {
            workflow: 'ICLR 2026 Submission Pre-Flight Check',
            itemsTouched: [
              'FLUX-12',
              'FlashAttention-2',
              'main.tex',
              'v3.1-Pre-Final',
            ],
          },
        },
      });

      return 'Emitted 2 activity stream events & 1 comprehensive session audit log';
    },
  );

  console.log(
    '\n================================================================================',
  );
  console.log('📊 RESEARCH LIFECYCLE EXECUTION SUMMARY');
  console.log(
    '================================================================================',
  );
  let successCount = 0;
  let errorCount = 0;
  for (const r of results) {
    const icon = r.status === 'SUCCESS' ? '✅' : '❌';
    console.log(`${icon} [${r.step}] ${r.name}`);
    console.log(`   └─ ${r.details}`);
    if (r.error) console.log(`   └─ Error: ${r.error}`);
    if (r.status === 'SUCCESS') successCount++;
    else errorCount++;
  }

  console.log(
    '--------------------------------------------------------------------------------',
  );
  console.log(
    `Total Steps: ${results.length} | Succeeded: ${successCount} | Errors: ${errorCount}`,
  );
  if (errorCount === 0) {
    console.log(
      '🎉 PERFECT RUN! All interconnected research workflows executed without any errors.',
    );
  } else {
    console.log('⚠️ Some steps encountered errors and need diagnosis.');
  }
  console.log(
    '================================================================================',
  );
}

runResearcherJourney()
  .catch((e) => {
    console.error('Fatal test error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
