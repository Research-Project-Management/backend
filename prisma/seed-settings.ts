import 'dotenv/config';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

async function seedSettings() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE email = $1', ['ngotanthanh92.26@gmail.com']);
    if (userRes.rows.length === 0) {
      throw new Error('User ngotanthanh92.26@gmail.com not found');
    }
    const userId = userRes.rows[0].id;

    // 1. Research Labels
    const labelsData = [
      { name: 'Baseline-Run', color: '#64748b', description: 'Standard benchmark run for comparative reference' },
      { name: 'Hyperparameter-Tuning', color: '#8b5cf6', description: 'Optuna / Ray Tune sweep experiments' },
      { name: 'Ablation-Study', color: '#06b6d4', description: 'Component contribution and isolation experiments' },
      { name: 'FP8-Quantization', color: '#10b981', description: 'Low-precision inference and latency optimization' },
      { name: 'SOTA-Candidate', color: '#f59e0b', description: 'Outperforms prior state-of-the-art on benchmark' },
      { name: 'Checkpoints-Archived', color: '#3b82f6', description: 'Validated weights uploaded to artifact storage' },
      { name: 'OOM-Investigating', color: '#ef4444', description: 'GPU VRAM exhaustion triage during scaling' },
      { name: 'Peer-Reviewed', color: '#ec4899', description: 'Results cited in camera-ready manuscript' },
    ];

    await pool.query('DELETE FROM labels WHERE user_id = $1', [userId]);
    for (const l of labelsData) {
      await pool.query(
        `INSERT INTO labels (id, user_id, name, color, description, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
        [randomUUID(), userId, l.name, l.color, l.description]
      );
    }
    console.log(`✅ Seeded ${labelsData.length} research labels.`);

    // 2. Scientific Integrations
    await pool.query('DELETE FROM user_integrations WHERE user_id = $1', [userId]);
    const integrations = [
      {
        provider: 'github',
        status: 'connected',
        accountName: 'tanthanh-flux-research',
        accountEmail: 'ngotanthanh92.26@gmail.com',
        metadata: {
          repos: ['flux-foundation-models', 'distributed-vit-training', 'scientific-eval-suite'],
          scopes: ['repo', 'read:org', 'workflow'],
        },
      },
      {
        provider: 'orcid',
        status: 'connected',
        accountName: 'Tan Thanh Ngo, Ph.D.',
        accountEmail: 'ngotanthanh92.26@gmail.com',
        metadata: {
          orcid_id: '0009-0004-8219-5820',
          verified_institution: 'Flux Laboratory for Neural Computing',
        },
      },
      {
        provider: 'zotero',
        status: 'connected',
        accountName: 'flux-lab-library',
        accountEmail: 'ngotanthanh92.26@gmail.com',
        metadata: {
          sync_items: 2450,
          collections_count: 18,
          last_sync: '2026-10-30T16:00:00Z',
        },
      },
      {
        provider: 'mendeley',
        status: 'connected',
        accountName: 'tanthanh.ngo',
        accountEmail: 'ngotanthanh92.26@gmail.com',
        metadata: {
          group_libraries: ['NeurIPS-2026-Working-Group', 'Transformer-Interpretability'],
        },
      },
    ];

    for (const i of integrations) {
      await pool.query(
        `INSERT INTO user_integrations (
          id, user_id, provider, status, account_name, account_email, provider_user_id, metadata, access_token, connected_at, last_synced_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), NOW())`,
        [
          randomUUID(),
          userId,
          i.provider,
          i.status,
          i.accountName,
          i.accountEmail,
          `uid_${i.provider}_${randomUUID().slice(0, 8)}`,
          JSON.stringify(i.metadata),
          `mock_token_${randomUUID().replace(/-/g, '')}`,
        ]
      );
    }
    console.log(`✅ Seeded ${integrations.length} scientific integrations.`);

    // 3. User Preferences & Scientific Editor Defaults
    await pool.query(
      `UPDATE user_settings
       SET preferences = jsonb_build_object(
         'default_run_tracking', 'wandb',
         'compute_cluster_endpoint', 'https://slurm.cluster.flux.ai',
         'auto_archive_checkpoints', true,
         'experiment_telemetry', true,
         'precision_mode', 'BF16'
       ),
       editor_config = jsonb_set(
         COALESCE(editor_config, '{}'::jsonb),
         '{academicMode}',
         'true'::jsonb
       )
       WHERE user_id = $1`,
      [userId]
    );
    console.log('✅ Updated user_settings with experiment management defaults.');

  } finally {
    await pool.end();
  }
}

seedSettings().catch((err) => {
  console.error('Error seeding settings:', err);
  process.exit(1);
});
