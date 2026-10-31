import 'dotenv/config';
import { Pool } from 'pg';
import { randomUUID, createHash } from 'crypto';

interface SeedFileItem {
  name: string;
  isFolder: boolean;
  mimeType: string;
  size: number;
  starred?: boolean;
  metaData?: Record<string, unknown>;
  changeComment?: string;
  versions?: {
    versionNumber: number;
    size: number;
    mimeType: string;
    comment: string;
  }[];
  children?: SeedFileItem[];
}

async function reseedStorageAsExperimentPlatform() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const pool = new Pool({ connectionString });
  console.log('🧪 Starting Clean Re-Seed for Storage as Experiment Management Platform...');

  try {
    const userRes = await pool.query('SELECT id, email FROM users WHERE email = $1', ['ngotanthanh92.26@gmail.com']);
    if (userRes.rows.length === 0) {
      throw new Error('User ngotanthanh92.26@gmail.com not found!');
    }
    const userId = userRes.rows[0].id;

    // Helper: create or get StorageBlob
    async function getOrCreateBlob(sizeBytes: number, extension: string): Promise<string> {
      const rawContent = `mock-exp-blob-${sizeBytes}-${extension}-${randomUUID()}`;
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

    // Helper: recursively insert
    async function insertItem(
      item: SeedFileItem,
      parentId: string | null = null,
      trashedAt: Date | null = null
    ): Promise<string> {
      const fileId = randomUUID();
      let blobId: string | null = null;

      if (!item.isFolder) {
        const ext = item.name.split('.').pop() || 'bin';
        blobId = await getOrCreateBlob(item.size, ext);
      }

      await pool.query(
        `INSERT INTO files (
          id, filename, size, mime_type, is_folder, starred, meta_data,
          parent_id, linked_to_type, blob_id, author_id, trashed_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'personal', $9, $10, $11, NOW(), NOW())`,
        [
          fileId,
          item.name,
          item.isFolder ? 0 : item.size,
          item.mimeType,
          item.isFolder,
          item.starred || false,
          JSON.stringify(item.metaData || {}),
          parentId,
          blobId,
          userId,
          trashedAt,
        ]
      );

      if (item.versions && item.versions.length > 0 && blobId) {
        for (const v of item.versions) {
          const vBlobId = await getOrCreateBlob(v.size, item.name.split('.').pop() || 'bin');
          await pool.query(
            `INSERT INTO file_versions (
              id, file_id, blob_id, version_number, size_bytes, mime_type, change_comment, created_by_id, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
            [randomUUID(), fileId, vBlobId, v.versionNumber, v.size, v.mimeType, v.comment, userId]
          );
        }
      }

      if (item.children && item.children.length > 0) {
        for (const child of item.children) {
          await insertItem(child, fileId, trashedAt);
        }
      }

      return fileId;
    }

    // 1. Clean existing files for this user
    console.log('🧹 Cleaning existing personal storage files...');
    await pool.query('DELETE FROM files WHERE author_id = $1', [userId]);

    // 2. Define High-Value Scientific Experiment Management Taxonomy
    const experimentStorageTree: SeedFileItem[] = [
      // ══════════════════════════════════════════════════════════════
      // 1. EXPERIMENTS & MODEL RUNS (Active Training Runs & Evaluations)
      // ══════════════════════════════════════════════════════════════
      {
        name: '🧪 Active Experiment Runs',
        isFolder: true,
        mimeType: 'application/x-directory',
        starred: true,
        metaData: {
          category: 'experiment_runs',
          description: 'Live SLURM and PyTorch distributed training runs with real-time logs & metrics',
        },
        children: [
          {
            name: 'RUN-2026-10-A1_vit_huge_patch14_contrastive',
            isFolder: true,
            mimeType: 'application/x-directory',
            starred: true,
            metaData: {
              run_id: 'RUN-2026-10-A1',
              model: 'ViT-Huge/14',
              dataset: 'ImageNet-22k + ScientificFigures-10M',
              cluster: '8x H100 SXM5 NVLink',
              status: 'COMPLETED',
              top1_val_acc: 88.42,
              epoch: 120,
            },
            children: [
              {
                name: 'hyperparameters_run_config.yaml',
                isFolder: false,
                mimeType: 'text/yaml',
                size: 6144,
                starred: true,
                metaData: {
                  optimizer: 'AdamW',
                  lr: 1.5e-4,
                  warmup_epochs: 15,
                  min_lr: 1e-6,
                  weight_decay: 0.05,
                  batch_size: 8192,
                  precision: 'BF16',
                },
              },
              {
                name: 'training_loss_and_lr_curves.json',
                isFolder: false,
                mimeType: 'application/json',
                size: 3450000,
                starred: true,
                metaData: {
                  steps: 180000,
                  final_train_loss: 0.384,
                  final_val_loss: 0.492,
                  metrics: ['loss', 'top1_acc', 'top5_acc', 'grad_norm', 'learning_rate'],
                },
              },
              {
                name: 'model_checkpoint_epoch120_best.safetensors',
                isFolder: false,
                mimeType: 'application/octet-stream',
                size: 2540000000,
                starred: true,
                metaData: {
                  parameters: '632M',
                  format: 'HuggingFace Safetensors',
                  top1_accuracy: 88.42,
                },
              },
              {
                name: 'slurm_distributed_execution.log',
                isFolder: false,
                mimeType: 'text/plain',
                size: 580000,
                metaData: {
                  nodes: 8,
                  gpus: 64,
                  total_compute_hours: 192.5,
                  slurm_job_id: 9283741,
                },
              },
              {
                name: 'confusion_matrix_val_eval.png',
                isFolder: false,
                mimeType: 'image/png',
                size: 1420000,
                metaData: {
                  classes: 1000,
                  top_confusions: ['terrier vs schnauzer', 'laptop vs notebook'],
                },
              },
            ],
          },
          {
            name: 'RUN-2026-10-B4_lora_rank64_instruction_tuning',
            isFolder: true,
            mimeType: 'application/x-directory',
            metaData: {
              run_id: 'RUN-2026-10-B4',
              base_model: 'Llama-3-70B-Base',
              technique: 'QLoRA Rank 64 Alpha 128',
              status: 'COMPLETED',
              eval_bleu: 44.18,
              eval_rougeL: 52.6,
            },
            children: [
              {
                name: 'adapter_config.json',
                isFolder: false,
                mimeType: 'application/json',
                size: 3200,
                metaData: {
                  r: 64,
                  lora_alpha: 128,
                  lora_dropout: 0.05,
                  target_modules: ['q_proj', 'k_proj', 'v_proj', 'o_proj'],
                },
              },
              {
                name: 'adapter_model.bin',
                isFolder: false,
                mimeType: 'application/octet-stream',
                size: 168000000,
                metaData: {
                  trainable_params_pct: 0.24,
                },
              },
              {
                name: 'synthetic_eval_generations.jsonl',
                isFolder: false,
                mimeType: 'application/json',
                size: 8900000,
                metaData: {
                  sample_count: 5000,
                  evaluator: 'GPT-4o-Judge',
                  win_rate: 76.4,
                },
              },
            ],
          },
          {
            name: 'RUN-2026-10-C2_deepspeed_zero3_offload_scaling',
            isFolder: true,
            mimeType: 'application/x-directory',
            metaData: {
              run_id: 'RUN-2026-10-C2',
              focus: 'Distributed Memory Optimization & Offloading',
              status: 'COMPLETED',
            },
            children: [
              {
                name: 'deepspeed_zero3_cpu_offload_config.json',
                isFolder: false,
                mimeType: 'application/json',
                size: 4500,
                metaData: {
                  stage: 3,
                  offload_optimizer: { device: 'cpu', pin_memory: true },
                  offload_param: { device: 'none' },
                },
              },
              {
                name: 'throughput_samples_per_second.csv',
                isFolder: false,
                mimeType: 'text/csv',
                size: 420000,
                metaData: {
                  columns: ['batch_size', 'seq_length', 'samples_per_sec', 'tflops_per_gpu', 'peak_vram_gb'],
                },
              },
            ],
          },
        ],
      },

      // ══════════════════════════════════════════════════════════════
      // 2. DATASETS & BENCHMARK SUITES
      // ══════════════════════════════════════════════════════════════
      {
        name: '📊 Datasets & Benchmark Suites',
        isFolder: true,
        mimeType: 'application/x-directory',
        starred: true,
        metaData: {
          category: 'datasets',
          description: 'Standardized research datasets, validation splits and streaming manifests',
        },
        children: [
          {
            name: 'imagenet1k_val_split_labels_manifest.jsonl',
            isFolder: false,
            mimeType: 'application/json',
            size: 12500000,
            starred: true,
            metaData: {
              total_samples: 50000,
              classes: 1000,
              format: 'JSONL with sha256 hashes',
            },
          },
          {
            name: 'multimodal_scientific_diagrams_eval_v2.parquet',
            isFolder: false,
            mimeType: 'application/octet-stream',
            size: 45200000,
            starred: true,
            metaData: {
              rows: 25000,
              columns: ['figure_id', 'paper_doi', 'caption', 'extracted_ocr_text', 'domain_tag'],
            },
          },
          {
            name: 'dataset_preprocessing_pipeline.py',
            isFolder: false,
            mimeType: 'text/x-python',
            size: 28400,
            metaData: {
              framework: 'Polars / PyArrow',
              transforms: ['RandomResizedCrop', 'RandAugment', 'MixUp', 'CutMix'],
            },
          },
          {
            name: 'synthetic_prompt_curation_golden_set.csv',
            isFolder: false,
            mimeType: 'text/csv',
            size: 3400000,
            metaData: {
              curator: 'Flux Research Lab',
              verified_expert_reviewed: true,
            },
          },
        ],
      },

      // ══════════════════════════════════════════════════════════════
      // 3. ABLATION STUDIES & SWEEPS
      // ══════════════════════════════════════════════════════════════
      {
        name: '🔬 Ablation Studies & Sweeps',
        isFolder: true,
        mimeType: 'application/x-directory',
        starred: false,
        metaData: {
          category: 'ablations',
          description: 'Controlled architectural variable isolation and sensitivity sweeps',
        },
        children: [
          {
            name: 'ablation_attention_head_pruning_table.xlsx',
            isFolder: false,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: 540000,
            starred: true,
            versions: [
              {
                versionNumber: 1,
                size: 320000,
                mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                comment: 'Initial 12-head vs 16-head comparison',
              },
              {
                versionNumber: 2,
                size: 450000,
                mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                comment: 'Added cross-attention head importance rankings',
              },
              {
                versionNumber: 3,
                size: 540000,
                mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                comment: 'Finalized pruning sensitivity thresholds for camera-ready',
              },
            ],
            metaData: {
              variables: ['heads_retained', 'accuracy_drop', 'inference_speedup_x'],
            },
          },
          {
            name: 'fp8_vs_bf16_quantization_ablation.csv',
            isFolder: false,
            mimeType: 'text/csv',
            size: 890000,
            metaData: {
              formats: ['FP32', 'BF16', 'FP8-E4M3', 'FP8-E5M2', 'INT4-AWQ'],
              latency_metrics: 'TTFT, TPOT, VRAM',
            },
          },
          {
            name: 'learning_rate_warmup_sweep_results.json',
            isFolder: false,
            mimeType: 'application/json',
            size: 1780000,
            metaData: {
              trials: 64,
              sweeper: 'Optuna TPE Sampler',
            },
          },
        ],
      },

      // ══════════════════════════════════════════════════════════════
      // 4. INFERENCE LATENCY & PROFILING
      // ══════════════════════════════════════════════════════════════
      {
        name: '⚡ Inference Benchmarks & Profiling',
        isFolder: true,
        mimeType: 'application/x-directory',
        starred: false,
        metaData: {
          category: 'profiling',
          description: 'Kernel traces, TensorRT-LLM engines, NVLink and latency profiles',
        },
        children: [
          {
            name: 'h100_nvlink_bandwidth_and_cuda_trace.json',
            isFolder: false,
            mimeType: 'application/json',
            size: 8400000,
            starred: true,
            metaData: {
              tool: 'PyTorch Profiler / Chrome Trace',
              nvlink_bandwidth_gbs: 900,
            },
          },
          {
            name: 'tensorrt_llm_engine_compilation_spec.yaml',
            isFolder: false,
            mimeType: 'text/yaml',
            size: 8200,
            metaData: {
              max_batch_size: 128,
              max_input_len: 4096,
              max_output_len: 2048,
              kv_cache_free_gpu_mem_fraction: 0.9,
            },
          },
          {
            name: 'latency_cdf_distribution_profile.png',
            isFolder: false,
            mimeType: 'image/png',
            size: 1850000,
            metaData: {
              percentiles: ['P50', 'P90', 'P99', 'P99.9'],
            },
          },
        ],
      },

      // ══════════════════════════════════════════════════════════════
      // 5. MANUSCRIPTS, CAMERA-READY & ARTIFACTS
      // ══════════════════════════════════════════════════════════════
      {
        name: '📄 Manuscripts & LaTeX Bundles',
        isFolder: true,
        mimeType: 'application/x-directory',
        starred: true,
        metaData: {
          category: 'publications',
          description: 'Camera-ready drafts, replication bundles, and conference camera-readies',
        },
        children: [
          {
            name: 'cvpr2026_camera_ready_final_manuscript.pdf',
            isFolder: false,
            mimeType: 'application/pdf',
            size: 8450000,
            starred: true,
            metaData: {
              track: 'Main Technical Conference',
              acceptance: 'Oral Presentation (top 3.2%)',
              pages: 14,
            },
          },
          {
            name: 'camera_ready_source_bundle.tar.gz',
            isFolder: false,
            mimeType: 'application/gzip',
            size: 38200000,
            metaData: {
              contents: ['main.tex', 'references.bib', 'figures/*.pdf', 'cvpr.sty'],
            },
          },
          {
            name: 'supplementary_material_and_reproducibility.pdf',
            isFolder: false,
            mimeType: 'application/pdf',
            size: 4200000,
            metaData: {
              proofs: 'Theorem 1-4 full mathematical derivation',
            },
          },
        ],
      },

      // ══════════════════════════════════════════════════════════════
      // 6. ROOT FILES (Experiment Overview, Manifests & Guides)
      // ══════════════════════════════════════════════════════════════
      {
        name: 'EXPERIMENT_TRACKER_MASTER.xlsx',
        isFolder: false,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        size: 1250000,
        starred: true,
        versions: [
          {
            versionNumber: 1,
            size: 890000,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            comment: 'Baseline runs 1-20 logging',
          },
          {
            versionNumber: 2,
            size: 1050000,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            comment: 'Added Ablation sweeps and distributed GPU scaling metrics',
          },
          {
            versionNumber: 3,
            size: 1250000,
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            comment: 'Consolidated final top-1 results across all 44 experiment runs',
          },
        ],
        metaData: {
          description: 'Master lab workbook recording all 44 training runs, loss, top-1 accuracy, and parameters',
        },
      },
      {
        name: 'model_architecture_neural_diagram.png',
        isFolder: false,
        mimeType: 'image/png',
        size: 2150000,
        starred: true,
        metaData: {
          resolution: '3840x2160',
          description: 'High-res block diagram of Hybrid Vision Transformer with Cross-Attention Heads',
        },
      },
      {
        name: 'cluster_slurm_environment_setup.sh',
        isFolder: false,
        mimeType: 'text/x-shellscript',
        size: 5400,
        starred: false,
        metaData: {
          target: 'CUDA 12.4 + PyTorch 2.4.0 + FlashAttention-2',
          os: 'Ubuntu 24.04 LTS HPC Node',
        },
      },
      {
        name: 'distributed_pretraining_master.yaml',
        isFolder: false,
        mimeType: 'text/yaml',
        size: 18400,
        starred: true,
        metaData: {
          framework: 'FSDP + DeepSpeed ZeRO-3',
          global_batch_size: 4096,
        },
      },
      {
        name: 'README_EXPERIMENT_REPLICATION.md',
        isFolder: false,
        mimeType: 'text/markdown',
        size: 9400,
        starred: true,
        metaData: {
          description: 'Complete recipe to replicate CVPR 2026 foundation model experiments from scratch',
        },
      },
    ];

    console.log(`🚀 Inserting ${experimentStorageTree.length} high-level experiment assets...`);
    for (const item of experimentStorageTree) {
      await insertItem(item, null, null);
    }

    // 3. Populate Trash with Realistic Research Artifacts (Failed OOM runs, corrupted checkpoints, obsolete logs)
    const trashItems: SeedFileItem[] = [
      {
        name: 'RUN-2026-10-FAILED_oom_batch_size_16384.log',
        isFolder: false,
        mimeType: 'text/plain',
        size: 1420000,
        metaData: {
          failure_reason: 'CUDA out of memory error during global batch size 16384 test',
        },
      },
      {
        name: 'corrupted_checkpoint_epoch03_disk_full.pth',
        isFolder: false,
        mimeType: 'application/octet-stream',
        size: 890000000,
        metaData: {
          failure_reason: 'I/O error during parallel save: disk quota reached on scratch partition',
        },
      },
      {
        name: 'obsolete_draft_notes_sep2025.docx',
        isFolder: false,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 650000,
        metaData: {
          failure_reason: 'Superseded by camera-ready LaTeX files',
        },
      },
      {
        name: 'scratch_temporary_data_dump_oct12',
        isFolder: true,
        mimeType: 'application/x-directory',
        metaData: {
          failure_reason: 'Temporary intermediate embeddings dump, purged after validation',
        },
      },
    ];

    const pastDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    for (const trashItem of trashItems) {
      await insertItem(trashItem, null, pastDate);
    }
    console.log(`🗑️ Inserted ${trashItems.length} research trash items.`);

    console.log('✨ All Storage experiment management data successfully re-seeded!');
  } finally {
    await pool.end();
  }
}

reseedStorageAsExperimentPlatform().catch((err) => {
  console.error('❌ Reseed failed:', err);
  process.exit(1);
});
