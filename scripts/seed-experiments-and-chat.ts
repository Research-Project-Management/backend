import 'dotenv/config';
import {
  PrismaClient,
  ConversationType,
  ConversationMemberRole,
  FriendshipStatus,
  MessageType,
  FilePermission,
  BlobStatus,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { seedRecents } from './seed-recents';

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
  console.log('🚀 Starting realistic Storage & Chat database seeding for ngotanthanh92.26@gmail.com...');

  // 1. Fetch Primary User Thanh
  const userThanh = await prisma.user.findFirst({
    where: { email: 'ngotanthanh92.26@gmail.com' },
    include: { profile: true },
  });

  if (!userThanh) {
    throw new Error('User ngotanthanh92.26@gmail.com not found in database. Run base seed first!');
  }
  console.log(`✅ Located Primary User: ${userThanh.email} (${userThanh.id})`);

  // Ensure collaborators exist
  let adminUser = await prisma.user.findFirst({ where: { email: 'admin@rpm.local' }, include: { profile: true } });
  let researcherUser = await prisma.user.findFirst({ where: { email: 'researcher@rpm.local' }, include: { profile: true } });
  let reviewerUser = await prisma.user.findFirst({ where: { email: 'reviewer@rpm.local' }, include: { profile: true } });

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

  // Get project "flux"
  const project = await prisma.project.findFirst({
    where: { name: 'flux' },
  });

  // --------------------------------------------------------------------------
  // 2. CLEAN PREVIOUS STORAGE & CHAT SEED DATA (Idempotent)
  // --------------------------------------------------------------------------
  console.log('🧹 Cleaning existing personal storage & chat data for user...');

  // Storage clean
  await prisma.fileShare.deleteMany({
    where: { OR: [{ userId: userThanh.id }, { file: { authorId: userThanh.id } }] },
  });
  await prisma.fileVersion.deleteMany({
    where: { file: { authorId: userThanh.id } },
  });
  await prisma.file.deleteMany({
    where: { authorId: userThanh.id },
  });
  await prisma.storageQuota.deleteMany({
    where: { userId: userThanh.id },
  });

  // Chat clean (conversations where userThanh is member or creator)
  const existingConvMembers = await prisma.conversationMember.findMany({
    where: { userId: userThanh.id },
    select: { conversationId: true },
  });
  const existingConvIds = existingConvMembers.map((m) => m.conversationId);

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

  // Friendships clean
  await prisma.friendship.deleteMany({
    where: { OR: [{ requesterId: userThanh.id }, { addresseeId: userThanh.id }] },
  });

  // --------------------------------------------------------------------------
  // 3. SEED REALISTIC STORAGE
  // --------------------------------------------------------------------------
  console.log('📁 Seeding realistic personal & collaborative Storage Drive...');

  // 3.1 Storage Quota
  const totalUsedBytes = BigInt(1845600000); // ~1.84 GB used
  const maxQuotaBytes = BigInt(21474836480); // 20 GB quota
  await prisma.storageQuota.create({
    data: {
      userId: userThanh.id,
      usedBytes: totalUsedBytes,
      maxBytes: maxQuotaBytes,
    },
  });

  // Helper to create a dummy StorageBlob
  async function createBlob(name: string, size: bigint) {
    const hash = crypto.createHash('sha256').update(`${name}-${Date.now()}-${Math.random()}`).digest();
    return prisma.storageBlob.create({
      data: {
        contentHash: hash,
        hashAlgorithm: 'SHA256',
        sizeBytes: size,
        s3Key: `blobs/${hash.toString('hex')}`,
        s3Bucket: 'flux',
        storageClass: 'STANDARD',
        refCount: 1,
        status: BlobStatus.READY,
      },
    });
  }

  // 3.2 Root Folders
  const folderPapers = await prisma.file.create({
    data: {
      filename: 'Research Papers & Literature',
      isFolder: true,
      size: BigInt(0),
      mimeType: 'application/x-directory',
      authorId: userThanh.id,
      metaData: { description: 'Curated collection of seminal computer vision & transformer papers', color: '#3b82f6' },
      createdAt: new Date(Date.now() - 30 * 86400000),
      updatedAt: new Date(Date.now() - 2 * 86400000),
    },
  });

  const folderDatasets = await prisma.file.create({
    data: {
      filename: 'Datasets & Benchmarks',
      isFolder: true,
      size: BigInt(0),
      mimeType: 'application/x-directory',
      authorId: userThanh.id,
      metaData: { description: 'Validation splits, evaluation scripts, and throughput benchmarks', color: '#10b981' },
      createdAt: new Date(Date.now() - 25 * 86400000),
      updatedAt: new Date(Date.now() - 3 * 86400000),
    },
  });

  const folderCheckpoints = await prisma.file.create({
    data: {
      filename: 'Experiment Checkpoints & Logs',
      isFolder: true,
      size: BigInt(0),
      mimeType: 'application/x-directory',
      authorId: userThanh.id,
      metaData: { description: 'Training logs, WandB export, and SLURM distributed cluster scripts', color: '#f59e0b' },
      createdAt: new Date(Date.now() - 20 * 86400000),
      updatedAt: new Date(Date.now() - 1 * 86400000),
    },
  });

  const folderSlides = await prisma.file.create({
    data: {
      filename: 'Presentations & Slides',
      isFolder: true,
      size: BigInt(0),
      mimeType: 'application/x-directory',
      authorId: userThanh.id,
      metaData: { description: 'Conference slides, lab defense, and keynote presentations', color: '#8b5cf6' },
      createdAt: new Date(Date.now() - 15 * 86400000),
      updatedAt: new Date(Date.now() - 4 * 86400000),
    },
  });

  const folderManuscripts = await prisma.file.create({
    data: {
      filename: 'Manuscripts & LaTeX Drafts',
      isFolder: true,
      size: BigInt(0),
      mimeType: 'application/x-directory',
      authorId: userThanh.id,
      metaData: { description: 'Camera-ready paper drafts, vector assets, and supplementary bundles', color: '#ec4899' },
      createdAt: new Date(Date.now() - 18 * 86400000),
      updatedAt: new Date(Date.now() - 1 * 86400000),
    },
  });

  // 3.3 Subfolders & Sub-files
  // Under Papers -> "ViT & Attention Models"
  const folderVit = await prisma.file.create({
    data: {
      filename: 'ViT & Attention Models',
      isFolder: true,
      size: BigInt(0),
      mimeType: 'application/x-directory',
      parentId: folderPapers.id,
      authorId: userThanh.id,
      createdAt: new Date(Date.now() - 28 * 86400000),
      updatedAt: new Date(Date.now() - 5 * 86400000),
    },
  });

  const blobVit1 = await createBlob('dosovitskiy2020_vit_16x16.pdf', BigInt(3565158));
  await prisma.file.create({
    data: {
      filename: 'dosovitskiy2020_vit_16x16.pdf',
      isFolder: false,
      size: BigInt(3565158),
      mimeType: 'application/pdf',
      parentId: folderVit.id,
      blobId: blobVit1.id,
      starred: true,
      authorId: userThanh.id,
      metaData: { description: 'An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale (ICLR 2021)' },
      createdAt: new Date(Date.now() - 25 * 86400000),
      updatedAt: new Date(Date.now() - 25 * 86400000),
    },
  });

  const blobVit2 = await createBlob('vaswani2017_attention_is_all_you_need.pdf', BigInt(2214589));
  await prisma.file.create({
    data: {
      filename: 'vaswani2017_attention_is_all_you_need.pdf',
      isFolder: false,
      size: BigInt(2214589),
      mimeType: 'application/pdf',
      parentId: folderVit.id,
      blobId: blobVit2.id,
      starred: false,
      authorId: userThanh.id,
      metaData: { description: 'Seminal Transformer architecture paper (NeurIPS 2017)' },
      createdAt: new Date(Date.now() - 24 * 86400000),
      updatedAt: new Date(Date.now() - 24 * 86400000),
    },
  });

  const blobVit3 = await createBlob('touvron2021_deit_distillation.pdf', BigInt(4982140));
  await prisma.file.create({
    data: {
      filename: 'touvron2021_deit_distillation.pdf',
      isFolder: false,
      size: BigInt(4982140),
      mimeType: 'application/pdf',
      parentId: folderVit.id,
      blobId: blobVit3.id,
      authorId: userThanh.id,
      metaData: { description: 'Training data-efficient image transformers & distillation through attention (ICML 2021)' },
      createdAt: new Date(Date.now() - 20 * 86400000),
      updatedAt: new Date(Date.now() - 20 * 86400000),
    },
  });

  // Under Datasets -> "ImageNet-1K Validation"
  const folderImageNet = await prisma.file.create({
    data: {
      filename: 'ImageNet-1K Validation',
      isFolder: true,
      size: BigInt(0),
      mimeType: 'application/x-directory',
      parentId: folderDatasets.id,
      authorId: userThanh.id,
      createdAt: new Date(Date.now() - 22 * 86400000),
      updatedAt: new Date(Date.now() - 6 * 86400000),
    },
  });

  const blobCsv1 = await createBlob('imagenet_val_top1_accuracy_matrix.csv', BigInt(1428570));
  await prisma.file.create({
    data: {
      filename: 'imagenet_val_top1_accuracy_matrix.csv',
      isFolder: false,
      size: BigInt(1428570),
      mimeType: 'text/csv',
      parentId: folderImageNet.id,
      blobId: blobCsv1.id,
      authorId: userThanh.id,
      metaData: { description: 'Top-1 / Top-5 validation accuracy metrics across ViT-B/16, ViT-L/16, and Swin-B' },
      createdAt: new Date(Date.now() - 14 * 86400000),
      updatedAt: new Date(Date.now() - 3 * 86400000),
    },
  });

  const blobJson1 = await createBlob('calibration_curve_metrics.json', BigInt(348160));
  await prisma.file.create({
    data: {
      filename: 'calibration_curve_metrics.json',
      isFolder: false,
      size: BigInt(348160),
      mimeType: 'application/json',
      parentId: folderImageNet.id,
      blobId: blobJson1.id,
      authorId: userThanh.id,
      metaData: { description: 'Expected Calibration Error (ECE) and reliability diagrams for model predictions' },
      createdAt: new Date(Date.now() - 10 * 86400000),
      updatedAt: new Date(Date.now() - 4 * 86400000),
    },
  });

  // Under Checkpoints
  const blobSh1 = await createBlob('run_distributed_ddp_slurm.sh', BigInt(4312));
  await prisma.file.create({
    data: {
      filename: 'run_distributed_ddp_slurm.sh',
      isFolder: false,
      size: BigInt(4312),
      mimeType: 'text/x-shellscript',
      parentId: folderCheckpoints.id,
      blobId: blobSh1.id,
      authorId: userThanh.id,
      metaData: { description: 'Production 8x H100 GPU SLURM multi-node batch submission script' },
      createdAt: new Date(Date.now() - 12 * 86400000),
      updatedAt: new Date(Date.now() - 2 * 86400000),
    },
  });

  const blobSummary = await createBlob('vit_base_patch16_epoch100_summary.json', BigInt(1884120));
  await prisma.file.create({
    data: {
      filename: 'vit_base_patch16_epoch100_summary.json',
      isFolder: false,
      size: BigInt(1884120),
      mimeType: 'application/json',
      parentId: folderCheckpoints.id,
      blobId: blobSummary.id,
      authorId: userThanh.id,
      metaData: { description: 'WandB full epoch 100 evaluation dump: gradient norm, learning rate schedule, loss' },
      createdAt: new Date(Date.now() - 8 * 86400000),
      updatedAt: new Date(Date.now() - 1 * 86400000),
    },
  });

  // Under Presentations
  const blobSlides1 = await createBlob('lab_seminar_vision_transformers_2026.pdf', BigInt(13421772));
  const fileSlides1 = await prisma.file.create({
    data: {
      filename: 'lab_seminar_vision_transformers_2026.pdf',
      isFolder: false,
      size: BigInt(13421772),
      mimeType: 'application/pdf',
      parentId: folderSlides.id,
      blobId: blobSlides1.id,
      starred: true,
      authorId: userThanh.id,
      metaData: { description: 'Department seminar keynote presentation on Attention & Scaled Vision' },
      createdAt: new Date(Date.now() - 14 * 86400000),
      updatedAt: new Date(Date.now() - 5 * 86400000),
    },
  });

  // Share presentation with Dr. Brody
  await prisma.fileShare.create({
    data: {
      fileId: fileSlides1.id,
      userId: reviewerUser.id,
      permission: FilePermission.view,
    },
  });

  // Under Manuscripts
  const blobMono = await createBlob('flux_monograph_final_camera_ready.pdf', BigInt(4823440));
  await prisma.file.create({
    data: {
      filename: 'flux_monograph_final_camera_ready.pdf',
      isFolder: false,
      size: BigInt(4823440),
      mimeType: 'application/pdf',
      parentId: folderManuscripts.id,
      blobId: blobMono.id,
      starred: true,
      authorId: userThanh.id,
      metaData: { description: 'Full 10-chapter research monograph compiled from Flux LaTeX workspace' },
      createdAt: new Date(Date.now() - 6 * 86400000),
      updatedAt: new Date(Date.now() - 1 * 86400000),
    },
  });

  const blobZip1 = await createBlob('figures_vector_assets_bundle.zip', BigInt(33984500));
  await prisma.file.create({
    data: {
      filename: 'figures_vector_assets_bundle.zip',
      isFolder: false,
      size: BigInt(33984500),
      mimeType: 'application/zip',
      parentId: folderManuscripts.id,
      blobId: blobZip1.id,
      authorId: userThanh.id,
      metaData: { description: 'High-resolution PDF & SVG vector charts for camera-ready submission' },
      createdAt: new Date(Date.now() - 5 * 86400000),
      updatedAt: new Date(Date.now() - 2 * 86400000),
    },
  });

  // 3.4 Root Level Files (with Versions and Collaborator Sharing!)
  // File 1: Research Proposal 2026 (with 3 versions!)
  const blobPropV1 = await createBlob('research_proposal_2026_v1.pdf', BigInt(2100000));
  const blobPropV2 = await createBlob('research_proposal_2026_v2.pdf', BigInt(2350000));
  const blobPropV3 = await createBlob('research_proposal_2026_v3.pdf', BigInt(2516582));

  const fileProposal = await prisma.file.create({
    data: {
      filename: 'research_proposal_2026.pdf',
      isFolder: false,
      size: BigInt(2516582),
      mimeType: 'application/pdf',
      parentId: null,
      blobId: blobPropV3.id,
      starred: true,
      authorId: userThanh.id,
      metaData: { description: 'Annual Research Grant & Compute Proposal on Foundation Architectures' },
      createdAt: new Date(Date.now() - 15 * 86400000),
      updatedAt: new Date(Date.now() - 2 * 86400000),
    },
  });

  await prisma.fileVersion.createMany({
    data: [
      {
        fileId: fileProposal.id,
        blobId: blobPropV1.id,
        versionNumber: 1,
        sizeBytes: BigInt(2100000),
        mimeType: 'application/pdf',
        changeComment: 'Initial grant draft submitted for internal faculty review',
        createdById: userThanh.id,
        createdAt: new Date(Date.now() - 15 * 86400000),
      },
      {
        fileId: fileProposal.id,
        blobId: blobPropV2.id,
        versionNumber: 2,
        sizeBytes: BigInt(2350000),
        mimeType: 'application/pdf',
        changeComment: 'Incorporated Dr. Evelyn Vance feedback regarding multi-node GPU compute budget',
        createdById: userThanh.id,
        createdAt: new Date(Date.now() - 8 * 86400000),
      },
      {
        fileId: fileProposal.id,
        blobId: blobPropV3.id,
        versionNumber: 3,
        sizeBytes: BigInt(2516582),
        mimeType: 'application/pdf',
        changeComment: 'Final revision with institutional sign-off and updated references',
        createdById: userThanh.id,
        createdAt: new Date(Date.now() - 2 * 86400000),
      },
    ],
  });

  // File 2: Model Architecture Diagram (Shared with Dr. Vance & Alex Chen)
  const blobArchPng = await createBlob('model_architecture_diagram.png', BigInt(1258291));
  const fileDiagram = await prisma.file.create({
    data: {
      filename: 'model_architecture_diagram.png',
      isFolder: false,
      size: BigInt(1258291),
      mimeType: 'image/png',
      parentId: null,
      blobId: blobArchPng.id,
      starred: true,
      authorId: userThanh.id,
      metaData: { description: 'Detailed block diagram of hybrid Vision Transformer with cross-attention heads' },
      createdAt: new Date(Date.now() - 10 * 86400000),
      updatedAt: new Date(Date.now() - 1 * 86400000),
    },
  });

  await prisma.fileShare.createMany({
    data: [
      {
        fileId: fileDiagram.id,
        userId: adminUser.id,
        permission: FilePermission.edit,
      },
      {
        fileId: fileDiagram.id,
        userId: researcherUser.id,
        permission: FilePermission.view,
      },
    ],
  });

  // File 3: Experiment Matrix v3 (Excel with 2 versions)
  const blobXlsxV1 = await createBlob('experiment_matrix_v1.xlsx', BigInt(142000));
  const blobXlsxV2 = await createBlob('experiment_matrix_v3.xlsx', BigInt(188416));

  const fileXlsx = await prisma.file.create({
    data: {
      filename: 'experiment_matrix_v3.xlsx',
      isFolder: false,
      size: BigInt(188416),
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      parentId: null,
      blobId: blobXlsxV2.id,
      authorId: userThanh.id,
      metaData: { description: 'Ablation study matrix tracking learning rates, weight decay, and throughput' },
      createdAt: new Date(Date.now() - 9 * 86400000),
      updatedAt: new Date(Date.now() - 3 * 86400000),
    },
  });

  await prisma.fileVersion.createMany({
    data: [
      {
        fileId: fileXlsx.id,
        blobId: blobXlsxV1.id,
        versionNumber: 1,
        sizeBytes: BigInt(142000),
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        changeComment: 'Initial setup of baseline hyperparameter matrix',
        createdById: userThanh.id,
        createdAt: new Date(Date.now() - 9 * 86400000),
      },
      {
        fileId: fileXlsx.id,
        blobId: blobXlsxV2.id,
        versionNumber: 2,
        sizeBytes: BigInt(188416),
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        changeComment: 'Added BF16 mixed-precision and FlashAttention-v2 throughput comparisons',
        createdById: researcherUser.id,
        createdAt: new Date(Date.now() - 3 * 86400000),
      },
    ],
  });

  await prisma.fileShare.create({
    data: {
      fileId: fileXlsx.id,
      userId: researcherUser.id,
      permission: FilePermission.edit,
    },
  });

  // File 4 & 5: Config & Readme
  const blobYaml = await createBlob('vit_large_pretraining_config.yaml', BigInt(14640));
  await prisma.file.create({
    data: {
      filename: 'vit_large_pretraining_config.yaml',
      isFolder: false,
      size: BigInt(14640),
      mimeType: 'application/x-yaml',
      parentId: null,
      blobId: blobYaml.id,
      authorId: userThanh.id,
      metaData: { description: 'YAML training spec with AdamW scheduler, CosineAnnealing, and batch size 4096' },
      createdAt: new Date(Date.now() - 7 * 86400000),
      updatedAt: new Date(Date.now() - 2 * 86400000),
    },
  });

  const blobMd = await createBlob('README_REPLICATION.md', BigInt(6963));
  await prisma.file.create({
    data: {
      filename: 'README_REPLICATION.md',
      isFolder: false,
      size: BigInt(6963),
      mimeType: 'text/markdown',
      parentId: null,
      blobId: blobMd.id,
      authorId: userThanh.id,
      metaData: { description: 'Step-by-step reproduction instructions, PyTorch environment, and conda setup' },
      createdAt: new Date(Date.now() - 11 * 86400000),
      updatedAt: new Date(Date.now() - 1 * 86400000),
    },
  });

  // 3.5 Realistic Trashed Items (so Trash tab functions!)
  const folderTrash = await prisma.file.create({
    data: {
      filename: 'deprecated_scratch_scripts_2025',
      isFolder: true,
      size: BigInt(0),
      mimeType: 'application/x-directory',
      parentId: null,
      authorId: userThanh.id,
      trashedAt: new Date(Date.now() - 12 * 86400000),
      createdAt: new Date(Date.now() - 40 * 86400000),
      updatedAt: new Date(Date.now() - 12 * 86400000),
    },
  });

  const blobTrash1 = await createBlob('corrupted_checkpoint_epoch2.pth', BigInt(152043520));
  await prisma.file.create({
    data: {
      filename: 'corrupted_checkpoint_epoch2.pth',
      isFolder: false,
      size: BigInt(152043520),
      mimeType: 'application/octet-stream',
      parentId: null,
      blobId: blobTrash1.id,
      authorId: userThanh.id,
      trashedAt: new Date(Date.now() - 8 * 86400000),
      createdAt: new Date(Date.now() - 14 * 86400000),
      updatedAt: new Date(Date.now() - 8 * 86400000),
    },
  });

  const blobTrash2 = await createBlob('test_eval_delete_me.txt', BigInt(1220));
  await prisma.file.create({
    data: {
      filename: 'test_eval_delete_me.txt',
      isFolder: false,
      size: BigInt(1220),
      mimeType: 'text/plain',
      parentId: null,
      blobId: blobTrash2.id,
      authorId: userThanh.id,
      trashedAt: new Date(Date.now() - 3 * 86400000),
      createdAt: new Date(Date.now() - 5 * 86400000),
      updatedAt: new Date(Date.now() - 3 * 86400000),
    },
  });

  console.log('✅ Storage seeding complete: Folders, Files, Blobs, Versions, Shares, and Trashed items seeded.');

  // --------------------------------------------------------------------------
  // 4. SEED REALISTIC CHAT & MESSENGER
  // --------------------------------------------------------------------------
  console.log('💬 Seeding realistic Chat conversations, messages, reactions, and channels...');

  // 4.1 Friendships (Thanh with all 3 academic collaborators)
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
    ],
  });

  // 4.2 CONVERSATION 1: Direct Chat with Dr. Evelyn Vance (Lab Director)
  const convVance = await prisma.conversation.create({
    data: {
      type: ConversationType.direct,
      createdById: userThanh.id,
      createdAt: new Date(Date.now() - 6 * 86400000),
      lastMessageAt: new Date(Date.now() - 2 * 3600000), // 2 hours ago
      lastSenderName: 'Dr. Evelyn Vance',
      lastMessageSnippet: "I've reviewed the latest grant section—the throughput numbers on H100 look solid. Go ahead and submit.",
      members: {
        create: [
          {
            userId: userThanh.id,
            role: ConversationMemberRole.member,
            lastReadAt: new Date(Date.now() - 1 * 3600000), // read
            isPinned: true,
          },
          {
            userId: adminUser.id,
            role: ConversationMemberRole.member,
            lastReadAt: new Date(Date.now()),
          },
        ],
      },
    },
  });

  const msgV1 = await prisma.message.create({
    data: {
      conversationId: convVance.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Chào cô Evelyn, em đã cập nhật lại bảng phân bổ GPU cluster trong đề cương nghiên cứu (research_proposal_2026.pdf) theo yêu cầu hôm thứ Hai ạ.',
      createdAt: new Date(Date.now() - 3 * 86400000),
    },
  });

  const msgV2 = await prisma.message.create({
    data: {
      conversationId: convVance.id,
      senderId: adminUser.id,
      type: MessageType.text,
      content: 'Great work, Thành! Are we using 8 nodes x 8 H100 for the 300-epoch pretraining run, or are we scaling to 16 nodes with Slurm job arrays?',
      createdAt: new Date(Date.now() - 2 * 86400000),
    },
  });

  const msgV3 = await prisma.message.create({
    data: {
      conversationId: convVance.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Em đã thử nghiệm với Slurm DDP trên 8 node trước. Kết quả đo đạc cho thấy NCCL ring-allreduce đạt 91% linear scaling efficiency khi bật FP8 mixed-precision. Em đã đính kèm script run_distributed_ddp_slurm.sh trong thư mục Checkpoints của Drive ạ.',
      replyToId: msgV2.id,
      createdAt: new Date(Date.now() - 1 * 86400000),
    },
  });

  const msgV4 = await prisma.message.create({
    data: {
      conversationId: convVance.id,
      senderId: adminUser.id,
      type: MessageType.text,
      content: "I've reviewed the latest grant section—the throughput numbers on H100 look solid. Go ahead and submit.",
      createdAt: new Date(Date.now() - 2 * 3600000),
    },
  });

  // Reactions for Vance conversation
  await prisma.messageReaction.createMany({
    data: [
      { messageId: msgV1.id, userId: adminUser.id, emoji: '👍', createdAt: new Date(Date.now() - 3 * 86400000 + 3600000) },
      { messageId: msgV3.id, userId: adminUser.id, emoji: '🚀', createdAt: new Date(Date.now() - 1 * 86400000 + 1800000) },
      { messageId: msgV4.id, userId: userThanh.id, emoji: '❤️', createdAt: new Date(Date.now() - 1 * 3600000) },
    ],
  });

  // 4.3 CONVERSATION 2: Direct Chat with Alex Chen (Senior ML Engineer)
  const convAlex = await prisma.conversation.create({
    data: {
      type: ConversationType.direct,
      createdById: researcherUser.id,
      createdAt: new Date(Date.now() - 5 * 86400000),
      lastMessageAt: new Date(Date.now() - 25 * 60000), // 25 mins ago
      lastSenderName: 'Alex Chen',
      lastMessageSnippet: 'Check the new FlashAttention-2 benchmarks in experiment_matrix_v3.xlsx. Latency dropped by 28%!',
      members: {
        create: [
          {
            userId: userThanh.id,
            role: ConversationMemberRole.member,
            lastReadAt: new Date(Date.now() - 30 * 60000), // 1 unread message!
            isPinned: true,
          },
          {
            userId: researcherUser.id,
            role: ConversationMemberRole.member,
            lastReadAt: new Date(Date.now()),
          },
        ],
      },
    },
  });

  const msgA1 = await prisma.message.create({
    data: {
      conversationId: convAlex.id,
      senderId: researcherUser.id,
      type: MessageType.text,
      content: 'Hey Thành! Did you push the updated patch embedding dimensions for the ViT-Large backbone?',
      createdAt: new Date(Date.now() - 2 * 86400000),
    },
  });

  const msgA2 = await prisma.message.create({
    data: {
      conversationId: convAlex.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Rồi Alex ơi! Mình vừa cập nhật file vit_large_pretraining_config.yaml lên Drive. Mình set patch_size=16, embed_dim=1024, num_heads=16 và dùng CosineAnnealingLR với 10k steps warmup nhé.',
      attachments: [
        {
          filename: 'vit_large_pretraining_config.yaml',
          size: 14640,
          mimeType: 'application/x-yaml',
        },
      ],
      createdAt: new Date(Date.now() - 1 * 86400000),
    },
  });

  const msgA3 = await prisma.message.create({
    data: {
      conversationId: convAlex.id,
      senderId: researcherUser.id,
      type: MessageType.text,
      content: 'Check the new FlashAttention-2 benchmarks in experiment_matrix_v3.xlsx. Latency dropped by 28%!',
      createdAt: new Date(Date.now() - 25 * 60000),
    },
  });

  await prisma.messageReaction.createMany({
    data: [
      { messageId: msgA2.id, userId: researcherUser.id, emoji: '🔥', createdAt: new Date(Date.now() - 1 * 86400000 + 3600000) },
    ],
  });

  // 4.4 CONVERSATION 3: Direct Chat with Dr. Marcus Brody (Reviewer / Advisory)
  const convBrody = await prisma.conversation.create({
    data: {
      type: ConversationType.direct,
      createdById: reviewerUser.id,
      createdAt: new Date(Date.now() - 8 * 86400000),
      lastMessageAt: new Date(Date.now() - 1 * 86400000),
      lastSenderName: 'Dr. Marcus Brody',
      lastMessageSnippet: 'The statistical significance p-value tests look robust. Ready for camera-ready.',
      members: {
        create: [
          {
            userId: userThanh.id,
            role: ConversationMemberRole.member,
            lastReadAt: new Date(Date.now()),
          },
          {
            userId: reviewerUser.id,
            role: ConversationMemberRole.member,
            lastReadAt: new Date(Date.now()),
          },
        ],
      },
    },
  });

  await prisma.message.createMany({
    data: [
      {
        conversationId: convBrody.id,
        senderId: userThanh.id,
        type: MessageType.text,
        content: 'Dear Dr. Brody, I have incorporated your recommendations on bootstrapping confidence intervals into Table 3 of the manuscript.',
        createdAt: new Date(Date.now() - 2 * 86400000),
      },
      {
        conversationId: convBrody.id,
        senderId: reviewerUser.id,
        type: MessageType.text,
        content: 'The statistical significance p-value tests look robust. Ready for camera-ready.',
        createdAt: new Date(Date.now() - 1 * 86400000),
      },
    ],
  });

  // 4.5 CONVERSATION 4: Group Chat: "Computer Vision & LLM Lab"
  const convLabGroup = await prisma.conversation.create({
    data: {
      type: ConversationType.group,
      name: 'Computer Vision & LLM Lab',
      topic: 'Weekly sync on Vision Transformers, Multimodal alignment, and Paper submissions',
      avatar: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150',
      createdById: userThanh.id,
      createdAt: new Date(Date.now() - 14 * 86400000),
      lastMessageAt: new Date(Date.now() - 4 * 3600000),
      lastSenderName: 'Dr. Evelyn Vance',
      lastMessageSnippet: 'Reminder: Lab seminar slides are due tomorrow 5 PM. Please upload to Drive.',
      members: {
        create: [
          { userId: userThanh.id, role: ConversationMemberRole.owner, isPinned: true, lastReadAt: new Date(Date.now() - 1 * 3600000) },
          { userId: adminUser.id, role: ConversationMemberRole.admin, lastReadAt: new Date() },
          { userId: researcherUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
          { userId: reviewerUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
        ],
      },
    },
  });

  const msgG1 = await prisma.message.create({
    data: {
      conversationId: convLabGroup.id,
      senderId: userThanh.id,
      type: MessageType.text,
      content: 'Chào cả nhóm! Tuần này mình sẽ trình bày về "Scaling Laws for Vision Transformers" tại buổi Seminar của Khoa vào thứ Năm nhé.',
      createdAt: new Date(Date.now() - 3 * 86400000),
    },
  });

  const msgG2 = await prisma.message.create({
    data: {
      conversationId: convLabGroup.id,
      senderId: researcherUser.id,
      type: MessageType.text,
      content: 'Awesome topic! I will prepare the benchmark comparison graphs on ImageNet-1K and ImageNet-A to accompany the talk.',
      createdAt: new Date(Date.now() - 2 * 86400000),
    },
  });

  const msgG3 = await prisma.message.create({
    data: {
      conversationId: convLabGroup.id,
      senderId: adminUser.id,
      type: MessageType.text,
      content: 'Reminder: Lab seminar slides are due tomorrow 5 PM. Please upload to Drive.',
      createdAt: new Date(Date.now() - 4 * 3600000),
    },
  });

  await prisma.messageReaction.createMany({
    data: [
      { messageId: msgG1.id, userId: adminUser.id, emoji: '👏', createdAt: new Date(Date.now() - 3 * 86400000 + 3600000) },
      { messageId: msgG1.id, userId: researcherUser.id, emoji: '🎉', createdAt: new Date(Date.now() - 3 * 86400000 + 7200000) },
      { messageId: msgG3.id, userId: userThanh.id, emoji: '👍', createdAt: new Date(Date.now() - 2 * 3600000) },
    ],
  });

  // 4.6 PROJECT CHANNELS (Linked to Project "flux"!)
  if (project) {
    // Channel #general
    const chGeneral = await prisma.conversation.create({
      data: {
        type: ConversationType.project_channel,
        name: 'general',
        topic: 'General team announcements, release updates, and milestone tracking for Flux',
        projectId: project.id,
        isDefault: true,
        createdById: userThanh.id,
        createdAt: new Date(Date.now() - 20 * 86400000),
        lastMessageAt: new Date(Date.now() - 10 * 3600000),
        lastSenderName: 'Tấn Thành',
        lastMessageSnippet: 'Milestone 4.2 completed: LaTeX monograph multi-file tree verified and synchronized.',
        members: {
          create: [
            { userId: userThanh.id, role: ConversationMemberRole.owner, lastReadAt: new Date() },
            { userId: adminUser.id, role: ConversationMemberRole.admin, lastReadAt: new Date() },
            { userId: researcherUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
          ],
        },
      },
    });

    await prisma.message.createMany({
      data: [
        {
          conversationId: chGeneral.id,
          senderId: adminUser.id,
          type: MessageType.text,
          content: 'Welcome everyone to the Flux core research workspace! All project documents, LaTeX files, and datasets are linked here.',
          createdAt: new Date(Date.now() - 15 * 86400000),
        },
        {
          conversationId: chGeneral.id,
          senderId: researcherUser.id,
          type: MessageType.text,
          content: 'Cloned repository and verified local compilation with TeXLive 2026. Everything builds cleanly.',
          createdAt: new Date(Date.now() - 10 * 86400000),
        },
        {
          conversationId: chGeneral.id,
          senderId: userThanh.id,
          type: MessageType.text,
          content: 'Milestone 4.2 completed: LaTeX monograph multi-file tree verified and synchronized.',
          createdAt: new Date(Date.now() - 10 * 3600000),
        },
      ],
    });

    // Channel #paper-drafting
    const chDrafting = await prisma.conversation.create({
      data: {
        type: ConversationType.project_channel,
        name: 'paper-drafting',
        topic: 'LaTeX drafting, Overleaf synchronization, and bibliography citation cross-referencing',
        projectId: project.id,
        isDefault: false,
        createdById: userThanh.id,
        createdAt: new Date(Date.now() - 18 * 86400000),
        lastMessageAt: new Date(Date.now() - 1 * 86400000),
        lastSenderName: 'Alex Chen',
        lastMessageSnippet: 'Section 4 (Methodology) equations and Figure 2 vector assets have been merged.',
        members: {
          create: [
            { userId: userThanh.id, role: ConversationMemberRole.owner, lastReadAt: new Date() },
            { userId: researcherUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
          ],
        },
      },
    });

    await prisma.message.createMany({
      data: [
        {
          conversationId: chDrafting.id,
          senderId: userThanh.id,
          type: MessageType.text,
          content: 'Alex ơi, bạn kiểm tra lại phần tham chiếu BibTeX trong Section 3 (Related Works) giúp mình nhé, đặc biệt là các trích dẫn về DeiT và Swin Transformer.',
          createdAt: new Date(Date.now() - 3 * 86400000),
        },
        {
          conversationId: chDrafting.id,
          senderId: researcherUser.id,
          type: MessageType.text,
          content: 'Section 4 (Methodology) equations and Figure 2 vector assets have been merged.',
          createdAt: new Date(Date.now() - 1 * 86400000),
        },
      ],
    });

    // Channel #gpu-cluster-benchmarks
    const chGpu = await prisma.conversation.create({
      data: {
        type: ConversationType.project_channel,
        name: 'gpu-cluster-benchmarks',
        topic: 'GPU cluster jobs, SLURM queuing, throughput, and hardware telemetry',
        projectId: project.id,
        isDefault: false,
        createdById: userThanh.id,
        createdAt: new Date(Date.now() - 12 * 86400000),
        lastMessageAt: new Date(Date.now() - 18 * 3600000),
        lastSenderName: 'Alex Chen',
        lastMessageSnippet: 'Node 04 InfiniBand link is back online at 400 Gbps.',
        members: {
          create: [
            { userId: userThanh.id, role: ConversationMemberRole.owner, lastReadAt: new Date() },
            { userId: researcherUser.id, role: ConversationMemberRole.member, lastReadAt: new Date() },
          ],
        },
      },
    });

    await prisma.message.create({
      data: {
        conversationId: chGpu.id,
        senderId: researcherUser.id,
        type: MessageType.text,
        content: 'Node 04 InfiniBand link is back online at 400 Gbps.',
        createdAt: new Date(Date.now() - 18 * 3600000),
      },
    });
  }

  console.log('✅ Chat seeding complete: Friendships, Direct Chats, Group Chats, and Project Channels seeded.');

  // 4.7 Recents (Activity Events across Work Items, LaTeX Pages, Papers, Storage Files)
  await seedRecents();

  // --------------------------------------------------------------------------
  // 5. CACHE INVALIDATION (Redis)
  // --------------------------------------------------------------------------
  if (redis) {
    try {
      console.log('🔄 Connecting to Redis to invalidate stale cache...');
      await redis.connect();
      const keys = await redis.keys('chat:*');
      const storageKeys = await redis.keys('storage:*');
      const allKeys = [...keys, ...storageKeys];
      if (allKeys.length > 0) {
        await redis.del(...allKeys);
        console.log(`🧹 Invalidation complete: Cleared ${allKeys.length} Redis cache keys.`);
      }
      redis.disconnect();
    } catch (err) {
      console.warn('⚠️ Redis cache invalidation skipped (Redis might not be running):', (err as Error).message);
    }
  }

  console.log('🎉 Seeding successfully finished! Your account is populated with real production data.');
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
