import 'dotenv/config';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

async function seedExperimentFolderTree() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE email = $1', ['ngotanthanh92.26@gmail.com']);
    if (userRes.rows.length === 0) {
      throw new Error('User ngotanthanh92.26@gmail.com not found');
    }
    const userId = userRes.rows[0].id;

    const updates = [
      {
        oldName: 'Experiment Checkpoints & Logs',
        newName: 'Experiments & Model Runs',
        meta: {
          description: 'Tracking model training runs, hyperparameters, GPU profiling and loss curves',
          experiment_type: 'Model Training & Evaluation',
          framework: 'PyTorch / SLURM',
        },
      },
      {
        oldName: 'Datasets & Benchmarks',
        newName: 'Datasets & Benchmark Suites',
        meta: {
          description: 'ImageNet-1K, GLUE, and synthetic benchmark validation splits',
          experiment_type: 'Data Pipelines',
        },
      },
      {
        oldName: 'Deep Learning & Foundation Models',
        newName: 'Ablation Studies & Baselines',
        meta: {
          description: 'Attention head isolation, layer pruning, and precision sweeps (FP16 vs BF16 vs FP8)',
          experiment_type: 'Ablation Experiments',
        },
      },
      {
        oldName: 'GenAI & Scientific Workflows',
        newName: 'Inference Latency & Optimization',
        meta: {
          description: 'TensorRT-LLM, vLLM, and TTFT/TPOT latency benchmark logs',
          experiment_type: 'Inference Profiling',
        },
      },
    ];

    for (const u of updates) {
      await pool.query(
        'UPDATE files SET filename = $1, meta_data = $2 WHERE author_id = $3 AND filename = $4 AND is_folder = true AND parent_id IS NULL',
        [u.newName, JSON.stringify(u.meta), userId, u.oldName]
      );
    }

    const expFolderRes = await pool.query(
      'SELECT id FROM files WHERE author_id = $1 AND filename = $2 AND is_folder = true',
      [userId, 'Experiments & Model Runs']
    );

    if (expFolderRes.rows.length > 0) {
      const expFolderId = expFolderRes.rows[0].id;
      const subRunNames = [
        'RUN-042_vit-large-patch14_imagenet1k',
        'RUN-043_lora-rank64-instruction-sweep',
        'RUN-044_deepspeed-zero3-8xH100-distributed',
      ];

      for (const runName of subRunNames) {
        const check = await pool.query(
          'SELECT id FROM files WHERE author_id = $1 AND parent_id = $2 AND filename = $3',
          [userId, expFolderId, runName]
        );
        if (check.rows.length === 0) {
          const subId = (
            await pool.query(
              'INSERT INTO files (id, filename, size, mime_type, is_folder, author_id, parent_id, created_at, updated_at) VALUES ($1, $2, 0, $3, true, $4, $5, NOW(), NOW()) RETURNING id',
              [randomUUID(), runName, 'application/x-directory', userId, expFolderId]
            )
          ).rows[0].id;

          await pool.query(
            'INSERT INTO files (id, filename, size, mime_type, is_folder, author_id, parent_id, meta_data, created_at, updated_at) VALUES ($1, $2, $3, $4, false, $5, $6, $7, NOW(), NOW())',
            [
              randomUUID(),
              'hyperparameters.yaml',
              4200,
              'text/yaml',
              userId,
              subId,
              JSON.stringify({ lr: 0.0003, weight_decay: 0.05, warmup_epochs: 10, batch_size: 4096 }),
            ]
          );
          await pool.query(
            'INSERT INTO files (id, filename, size, mime_type, is_folder, author_id, parent_id, meta_data, created_at, updated_at) VALUES ($1, $2, $3, $4, false, $5, $6, $7, NOW(), NOW())',
            [
              randomUUID(),
              'metrics_summary_eval.json',
              18400,
              'application/json',
              userId,
              subId,
              JSON.stringify({ top1_accuracy: 84.85, top5_accuracy: 97.2, eval_loss: 0.624, best_epoch: 94 }),
            ]
          );
          await pool.query(
            'INSERT INTO files (id, filename, size, mime_type, is_folder, author_id, parent_id, meta_data, created_at, updated_at) VALUES ($1, $2, $3, $4, false, $5, $6, $7, NOW(), NOW())',
            [
              randomUUID(),
              'slurm_execution.log',
              245000,
              'text/plain',
              userId,
              subId,
              JSON.stringify({ nodes: 8, gpus: 64, total_steps: 125000, status: 'COMPLETED' }),
            ]
          );
        }
      }
    }

    console.log('✅ Experiment management folders and sub-run artifacts populated.');
  } finally {
    await pool.end();
  }
}

seedExperimentFolderTree().catch((err) => {
  console.error('Error seeding experiment folders:', err);
  process.exit(1);
});
