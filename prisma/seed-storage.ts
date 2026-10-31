import 'dotenv/config';
import { Pool } from 'pg';
import { randomUUID, createHash } from 'crypto';

interface SeedFile {
  name: string;
  isFolder: boolean;
  mimeType: string;
  size: number;
  starred?: boolean;
  trashedAt?: string | null;
  metaData?: Record<string, unknown>;
  changeComment?: string;
  versions?: {
    versionNumber: number;
    size: number;
    mimeType: string;
    comment: string;
    createdById?: string;
  }[];
  shares?: {
    sharedWithEmail: string;
    permission: 'view' | 'edit';
  }[];
  children?: SeedFile[];
}

async function run() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not defined in environment');
  }

  const pool = new Pool({ connectionString });
  console.log('🌱 Starting comprehensive Storage Seeding for current logged-in user...');

  try {
    // 1. Identify users
    const usersRes = await pool.query(
      'SELECT u.id, u.email, p.name FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id'
    );
    const userMap = new Map<string, { id: string; email: string; name: string }>();
    for (const r of usersRes.rows) {
      userMap.set(r.email, r);
    }

    const currentLoggedInUser = userMap.get('ngotanthanh92.26@gmail.com');
    if (!currentLoggedInUser) {
      throw new Error('Current user ngotanthanh92.26@gmail.com not found in database!');
    }
    console.log(`👤 Current User: ${currentLoggedInUser.name} (${currentLoggedInUser.email}) [${currentLoggedInUser.id}]`);

    const colabAdmin = userMap.get('admin@rpm.local') || currentLoggedInUser;
    const colabResearcher = userMap.get('researcher@rpm.local') || currentLoggedInUser;
    const colabReviewer = userMap.get('reviewer@rpm.local') || currentLoggedInUser;
    const colabSophia = userMap.get('sophia.lin@rpm.local') || currentLoggedInUser;
    const colabDavid = userMap.get('david.m@univ.edu') || currentLoggedInUser;

    // Helper: create or get StorageBlob
    async function getOrCreateBlob(sizeBytes: number, extension: string): Promise<string> {
      const rawContent = `mock-content-${sizeBytes}-${extension}-${randomUUID()}`;
      const hash = createHash('sha256').update(rawContent).digest();
      const s3Key = `blobs/${hash.toString('hex').slice(0, 2)}/${hash.toString('hex').slice(2, 4)}/${hash.toString('hex')}`;
      
      const insertBlob = await pool.query(
        `INSERT INTO storage_blobs (id, content_hash, hash_algorithm, size_bytes, s3_key, s3_bucket, storage_class, ref_count, status, created_at)
         VALUES ($1, $2, 'SHA256', $3, $4, 'flux-storage-local', 'STANDARD', 1, 'READY', NOW())
         RETURNING id`,
        [randomUUID(), hash, sizeBytes, s3Key]
      );
      return insertBlob.rows[0].id;
    }

    // Helper: recursively insert folder tree
    async function insertTree(
      item: SeedFile,
      authorId: string,
      parentId: string | null = null,
      scopeType: string | null = null,
      scopeId: string | null = null
    ) {
      const fileId = randomUUID();
      let blobId: string | null = null;

      if (!item.isFolder) {
        const ext = item.name.split('.').pop() || 'bin';
        blobId = await getOrCreateBlob(item.size, ext);
      }

      const now = new Date();
      const trashedDate = item.trashedAt ? new Date(item.trashedAt) : null;

      await pool.query(
        `INSERT INTO files (
          id, filename, size, mime_type, is_folder, starred, meta_data,
          parent_id, linked_to_type, linked_to_id, blob_id, author_id,
          trashed_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
        [
          fileId,
          item.name,
          item.isFolder ? 0 : item.size,
          item.mimeType,
          item.isFolder,
          item.starred || false,
          JSON.stringify(item.metaData || {}),
          parentId,
          scopeType,
          scopeId,
          blobId,
          authorId,
          trashedDate,
          now,
        ]
      );

      // Versions
      if (item.versions && item.versions.length > 0 && blobId) {
        for (const v of item.versions) {
          const vBlobId = await getOrCreateBlob(v.size, item.name.split('.').pop() || 'bin');
          await pool.query(
            `INSERT INTO file_versions (
              id, file_id, blob_id, version_number, size_bytes, mime_type, change_comment, created_by_id, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
            [
              randomUUID(),
              fileId,
              vBlobId,
              v.versionNumber,
              v.size,
              v.mimeType,
              v.comment,
              v.createdById || authorId,
            ]
          );
        }
      }

      // Shares
      if (item.shares && item.shares.length > 0) {
        for (const s of item.shares) {
          const target = userMap.get(s.sharedWithEmail);
          if (target) {
            await pool.query(
              `INSERT INTO file_shares (id, file_id, user_id, permission, created_at)
               VALUES ($1, $2, $3, $4, NOW())
               ON CONFLICT (file_id, user_id) DO UPDATE SET permission = EXCLUDED.permission`,
              [randomUUID(), fileId, target.id, s.permission]
            );
          }
        }
      }

      // Children folders/files
      if (item.children && item.children.length > 0) {
        for (const child of item.children) {
          await insertTree(child, authorId, fileId, scopeType, scopeId);
        }
      }

      return fileId;
    }

    // --- 2.1 EXPAND "MY FILES" FOR CURRENT LOGGED IN USER ---
    console.log('📁 Populating Rich Real-World Folders and Documents in "My Files"...');

    const myFilesData: SeedFile[] = [
      {
        name: 'Deep Learning & Foundation Models',
        isFolder: true,
        mimeType: 'application/x-directory',
        starred: true,
        children: [
          {
            name: 'State-of-the-Art Papers',
            isFolder: true,
            mimeType: 'application/x-directory',
            children: [
              {
                name: 'vaswani2017_attention_is_all_you_need.pdf',
                isFolder: false,
                mimeType: 'application/pdf',
                size: 2215000,
                starred: true,
                metaData: {
                  description: 'Original Transformer architecture introducing Multi-Head Self-Attention',
                  pages: 15,
                  doi: '10.48550/arXiv.1706.03762',
                },
              },
              {
                name: 'dosovitskiy2020_an_image_is_worth_16x16_words.pdf',
                isFolder: false,
                mimeType: 'application/pdf',
                size: 3560000,
                starred: true,
                metaData: {
                  description: 'Vision Transformer (ViT) architecture applied directly to image patches',
                  pages: 22,
                  conference: 'ICLR 2021',
                },
              },
              {
                name: 'touvron2023_llama2_open_foundation_models.pdf',
                isFolder: false,
                mimeType: 'application/pdf',
                size: 13620000,
                starred: false,
                metaData: {
                  description: 'Llama 2: Open Foundation and Fine-Tuned Chat Models technical report',
                  pages: 77,
                },
              },
              {
                name: 'gemini_1_5_multimodal_architecture_report.pdf',
                isFolder: false,
                mimeType: 'application/pdf',
                size: 8940000,
                starred: true,
                metaData: {
                  description: 'Gemini 1.5: Unlocking multimodal understanding across millions of tokens',
                  pages: 45,
                },
              },
            ],
          },
          {
            name: 'Training Checkpoints & Weights',
            isFolder: true,
            mimeType: 'application/x-directory',
            children: [
              {
                name: 'vit_base_patch16_224_in1k_checkpoint_epoch90.safetensors',
                isFolder: false,
                mimeType: 'application/octet-stream',
                size: 343200000,
                starred: true,
                metaData: {
                  framework: 'PyTorch / HuggingFace Safetensors',
                  precision: 'BF16',
                  top1_accuracy: 84.62,
                  step: 140000,
                },
              },
              {
                name: 'lora_adapter_instruction_tuning_v4.bin',
                isFolder: false,
                mimeType: 'application/octet-stream',
                size: 42000000,
                metaData: {
                  rank: 64,
                  alpha: 128,
                  target_modules: ['q_proj', 'v_proj', 'k_proj', 'o_proj'],
                },
              },
              {
                name: 'training_loss_curves_tensorboard.json',
                isFolder: false,
                mimeType: 'application/json',
                size: 2450000,
                metaData: {
                  metrics: ['train_loss', 'val_loss', 'learning_rate', 'grad_norm'],
                  optimizer: 'AdamW',
                },
              },
            ],
          },
          {
            name: 'PyTorch & Distributed Training Configs',
            isFolder: true,
            mimeType: 'application/x-directory',
            children: [
              {
                name: 'deepspeed_zero3_offload_config.json',
                isFolder: false,
                mimeType: 'application/json',
                size: 6400,
                metaData: {
                  zero_optimization: { stage: 3, offload_optimizer: { device: 'cpu' } },
                },
              },
              {
                name: 'slurm_h100_cluster_multi_node_job.sh',
                isFolder: false,
                mimeType: 'text/x-shellscript',
                size: 5120,
                metaData: {
                  nodes: 8,
                  gpus_per_node: 8,
                  partition: 'gpu-h100-nvlink',
                },
              },
              {
                name: 'fsdp_distributed_pretraining.py',
                isFolder: false,
                mimeType: 'text/x-python',
                size: 38400,
                metaData: {
                  description: 'Fully Sharded Data Parallel training script with activation checkpointing',
                },
              },
            ],
          },
        ],
      },
      {
        name: 'GenAI & Scientific Workflows',
        isFolder: true,
        mimeType: 'application/x-directory',
        starred: false,
        children: [
          {
            name: 'benchmark_inference_latency_eval.csv',
            isFolder: false,
            mimeType: 'text/csv',
            size: 890000,
            starred: true,
            metaData: {
              rows: 15400,
              columns: ['model', 'batch_size', 'seq_len', 'ttft_ms', 'tpot_ms', 'vram_gb'],
            },
          },
          {
            name: 'scientific_multimodal_rag_pipeline.drawio.png',
            isFolder: false,
            mimeType: 'image/png',
            size: 4320000,
            starred: true,
            metaData: {
              resolution: '3840x2160',
              description: 'Architecture diagram showing hybrid vector + BM25 retrieval over scientific PDF figures',
            },
          },
          {
            name: 'synthetic_evaluation_golden_set.json',
            isFolder: false,
            mimeType: 'application/json',
            size: 3200000,
            metaData: {
              num_queries: 1250,
              domain: 'Computer Vision & Bioinformatics',
            },
          },
        ],
      },
      {
        name: 'Manuscripts & Grants 2026',
        isFolder: true,
        mimeType: 'application/x-directory',
        starred: true,
        children: [
          {
            name: 'nsf_career_proposal_final_budget.xlsx',
            isFolder: false,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: 480000,
            starred: true,
            metaData: {
              total_budget_usd: 540000,
              period: '2026 - 2031',
            },
          },
          {
            name: 'cvpr2026_camera_ready_manuscript.pdf',
            isFolder: false,
            mimeType: 'application/pdf',
            size: 7850000,
            starred: true,
            metaData: {
              track: 'Main Conference',
              acceptance_type: 'Oral Presentation',
            },
          },
          {
            name: 'ieee_transactions_review_response_letter.docx',
            isFolder: false,
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            size: 1250000,
            metaData: {
              status: 'Minor Revisions',
              reviewers: 3,
            },
          },
        ],
      },
      // Root-level files for variety in "My Files"
      {
        name: 'flux_system_overview_whitepaper.pdf',
        isFolder: false,
        mimeType: 'application/pdf',
        size: 5420000,
        starred: true,
        metaData: {
          description: 'Official architectural monograph and technical documentation for Flux Research Workspace',
          pages: 34,
        },
      },
      {
        name: 'experiment_hyperparameters_tracking.xlsx',
        isFolder: false,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 920000,
        starred: false,
        versions: [
          {
            versionNumber: 1,
            size: 650000,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            comment: 'Baseline learning rate schedule with SGD',
            createdById: currentLoggedInUser.id,
          },
          {
            versionNumber: 2,
            size: 780000,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            comment: 'Switched to AdamW with warmup Cosine Annealing',
            createdById: currentLoggedInUser.id,
          },
          {
            versionNumber: 3,
            size: 920000,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            comment: 'Added FP8 quantization evaluation and memory consumption benchmarks',
            createdById: colabResearcher.id,
          },
        ],
      },
      {
        name: 'h100_cluster_gpu_utilization_profile.mp4',
        isFolder: false,
        mimeType: 'video/mp4',
        size: 28400000,
        starred: false,
        metaData: {
          duration_seconds: 142,
          resolution: '1920x1080',
          fps: 60,
          description: 'Screen recording profiling NVLink saturation and CUDA kernel throughput',
        },
      },
      {
        name: 'flux_platform_keynote_presentation.pptx',
        isFolder: false,
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        size: 18200000,
        starred: true,
        metaData: {
          slides: 48,
          theme: 'Modern Dark Scientific',
        },
      },
      {
        name: 'cluster_environment_setup.sh',
        isFolder: false,
        mimeType: 'text/x-shellscript',
        size: 4200,
        starred: false,
        metaData: {
          os: 'Ubuntu 24.04 LTS',
          cuda: '12.4',
        },
      },
    ];

    for (const item of myFilesData) {
      await insertTree(item, currentLoggedInUser.id, null);
    }

    // --- 2.2 POPULATE "SHARED WITH ME" (Files authored by colleagues and shared to currentLoggedInUser) ---
    console.log('🤝 Populating "Shared with Me" files from colleagues...');

    const sharedWithMeFiles: { author: typeof colabAdmin; file: SeedFile; permission: 'view' | 'edit' }[] = [
      {
        author: colabAdmin,
        permission: 'edit',
        file: {
          name: 'Institutional_GPU_Allocation_Q4_2026.xlsx',
          isFolder: false,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 1420000,
          starred: true,
          metaData: {
            department: 'Computing & AI Infrastructure Committee',
            shared_notes: 'Thành, please review your lab GPU hours request on Sheet 3 before Friday.',
          },
        },
      },
      {
        author: colabSophia,
        permission: 'view',
        file: {
          name: 'Multi_Agent_Autonomous_Research_Workflow.pdf',
          isFolder: false,
          mimeType: 'application/pdf',
          size: 6100000,
          starred: true,
          metaData: {
            description: 'Draft survey paper on collaborative LLM agents conducting automated literature review',
            pages: 28,
            shared_notes: 'Dr. Lin requested your feedback on section 4.2 (Memory architecture).',
          },
        },
      },
      {
        author: colabResearcher,
        permission: 'edit',
        file: {
          name: 'cross_attention_fp8_kernel_benchmark.csv',
          isFolder: false,
          mimeType: 'text/csv',
          size: 780000,
          starred: false,
          metaData: {
            kernel: 'Triton FP8 GEMM',
            speedup: '1.84x vs cuBLAS BF16',
          },
        },
      },
      {
        author: colabReviewer,
        permission: 'view',
        file: {
          name: 'peer_review_consensus_report_v2.pdf',
          isFolder: false,
          mimeType: 'application/pdf',
          size: 2150000,
          starred: false,
          metaData: {
            venue: 'Nature Machine Intelligence',
            round: 2,
            recommendation: 'Accept with minor clarifications',
          },
        },
      },
      {
        author: colabDavid,
        permission: 'view',
        file: {
          name: 'Bioinformatics_SingleCell_Genomics_Preprint.pdf',
          isFolder: false,
          mimeType: 'application/pdf',
          size: 14500000,
          starred: false,
          metaData: {
            institution: 'Genomics Research Institute',
            pages: 42,
          },
        },
      },
    ];

    for (const item of sharedWithMeFiles) {
      const fileId = await insertTree(item.file, item.author.id, null);
      await pool.query(
        `INSERT INTO file_shares (id, file_id, user_id, permission, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (file_id, user_id) DO UPDATE SET permission = EXCLUDED.permission`,
        [randomUUID(), fileId, currentLoggedInUser.id, item.permission]
      );
    }

    // --- 2.3 POPULATE "TRASH" (Realistic deleted items with various timestamps for currentLoggedInUser) ---
    console.log('🗑️ Populating realistic Deleted Items in Trash...');

    const trashItems: SeedFile[] = [
      {
        name: 'deprecated_training_run_failed_oom.log',
        isFolder: false,
        mimeType: 'text/plain',
        size: 24500000,
        trashedAt: '2026-10-25T14:20:00.000Z',
        metaData: {
          reason: 'CUDA out of memory error during batch size 8192 scaling test',
        },
      },
      {
        name: 'draft_abstract_submission_obsolete.docx',
        isFolder: false,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 340000,
        trashedAt: '2026-10-28T09:15:00.000Z',
        metaData: {
          reason: 'Merged into main camera ready draft',
        },
      },
      {
        name: 'scratch_temporary_data_dump_oct12',
        isFolder: true,
        mimeType: 'application/x-directory',
        trashedAt: '2026-10-22T18:00:00.000Z',
        children: [
          {
            name: 'temp_debug_features.npy',
            isFolder: false,
            mimeType: 'application/octet-stream',
            size: 48000000,
          },
          {
            name: 'intermediate_clustering_plot.png',
            isFolder: false,
            mimeType: 'image/png',
            size: 1200000,
          },
        ],
      },
      {
        name: 'corrupted_archive_download.zip',
        isFolder: false,
        mimeType: 'application/zip',
        size: 89000000,
        trashedAt: '2026-10-18T11:45:00.000Z',
        metaData: {
          reason: 'Checksum mismatch after network interruption',
        },
      },
    ];

    for (const item of trashItems) {
      await insertTree(item, currentLoggedInUser.id, null);
    }

    // Quota tracking intentionally skipped (unlimited / not required)

    // Final summary check
    const countCheck = await pool.query(
      `SELECT 
        COUNT(*) AS total_files,
        COUNT(CASE WHEN trashed_at IS NULL THEN 1 END) AS active_files,
        COUNT(CASE WHEN trashed_at IS NOT NULL THEN 1 END) AS trash_files,
        COUNT(CASE WHEN starred = true THEN 1 END) AS starred_files
       FROM files WHERE author_id = $1`,
      [currentLoggedInUser.id]
    );

    const sharedCountCheck = await pool.query(
      `SELECT COUNT(*) AS shared_count FROM file_shares WHERE user_id = $1`,
      [currentLoggedInUser.id]
    );

    console.log('\n🎉 Storage Seeding Summary for ' + currentLoggedInUser.email + ':');
    console.log('----------------------------------------------------');
    console.log(`📁 Total Personal Files/Folders : ${countCheck.rows[0].total_files}`);
    console.log(`📄 Active Files in My Files     : ${countCheck.rows[0].active_files}`);
    console.log(`⭐ Starred Files                : ${countCheck.rows[0].starred_files}`);
    console.log(`🗑️ Items in Trash               : ${countCheck.rows[0].trash_files}`);
    console.log(`🤝 Files Shared With Me          : ${sharedCountCheck.rows[0].shared_count}`);
    console.log('----------------------------------------------------\n');

  } catch (err) {
    console.error('❌ Seeding failed with error:', err);
    throw err;
  } finally {
    await pool.end();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
