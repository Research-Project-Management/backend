import pg from 'pg';
import Redis from 'ioredis';

const DATABASE_URL = 'postgresql://postgres:Thanh26102006@127.0.0.1:5433/flux-db?schema=public';
const REDIS_URL = 'redis://127.0.0.1:6379';

async function standardizeDates() {
  console.log('🔄 Standardizing work-item dates...');
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const redis = new Redis(REDIS_URL);

  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;

  // Define date policy:
  // - Only major ongoing multi-day tasks in 'in_progress' have startDate + dueDate (Range)
  // - Most tasks only have dueDate (Single Date)
  // - Long-term backlog tasks have no date or only target dueDate
  const dateConfigs = [
    // ── BACKLOG (1-8): No startDate! Target dueDate or null ──
    { seq: 1, startDelta: null, daysDelta: 32 },
    { seq: 2, startDelta: null, daysDelta: 35 },
    { seq: 3, startDelta: null, daysDelta: null },
    { seq: 4, startDelta: null, daysDelta: 39 },
    { seq: 5, startDelta: null, daysDelta: null },
    { seq: 6, startDelta: null, daysDelta: 45 },
    { seq: 7, startDelta: null, daysDelta: null },
    { seq: 8, startDelta: null, daysDelta: 52 },

    // ── TO DO (9-18): No startDate (unstarted)! Only dueDate ──
    { seq: 9, startDelta: null, daysDelta: 7 },
    { seq: 10, startDelta: null, daysDelta: 4 },
    { seq: 11, startDelta: null, daysDelta: 9 },
    { seq: 12, startDelta: null, daysDelta: 10 },
    { seq: 13, startDelta: null, daysDelta: 12 },
    { seq: 14, startDelta: null, daysDelta: 3 },
    { seq: 15, startDelta: null, daysDelta: 13 },
    { seq: 16, startDelta: null, daysDelta: 11 },
    { seq: 17, startDelta: null, daysDelta: 12 },
    { seq: 18, startDelta: null, daysDelta: 8 },

    // ── IN PROGRESS (19-34): Only 4 major tasks have Date Range, rest only dueDate ──
    { seq: 19, startDelta: -6, daysDelta: 4 }, // Range: 28/09 - 08/10
    { seq: 20, startDelta: null, daysDelta: -3 }, // subtask completed
    { seq: 21, startDelta: null, daysDelta: 0 },  // subtask completed
    { seq: 22, startDelta: null, daysDelta: 3 },
    { seq: 23, startDelta: -5, daysDelta: 5 }, // Range: 29/09 - 09/10
    { seq: 24, startDelta: null, daysDelta: -1 }, // subtask completed
    { seq: 25, startDelta: null, daysDelta: 4 },
    { seq: 26, startDelta: null, daysDelta: 6 },
    { seq: 27, startDelta: -3, daysDelta: 3 }, // Range: 01/10 - 07/10
    { seq: 28, startDelta: null, daysDelta: 5 },
    { seq: 29, startDelta: null, daysDelta: 1 },
    { seq: 30, startDelta: null, daysDelta: 4 },
    { seq: 31, startDelta: -2, daysDelta: 4 }, // Range: 02/10 - 08/10
    { seq: 32, startDelta: null, daysDelta: 2 },
    { seq: 33, startDelta: null, daysDelta: 5 },
    { seq: 34, startDelta: null, daysDelta: 4 },

    // ── DONE (35-41): No startDate! Only dueDate ──
    { seq: 35, startDelta: null, daysDelta: -2 },
    { seq: 36, startDelta: null, daysDelta: -5 },
    { seq: 37, startDelta: null, daysDelta: -10 },
    { seq: 38, startDelta: null, daysDelta: -7 },
    { seq: 39, startDelta: null, daysDelta: -16 },
    { seq: 40, startDelta: null, daysDelta: -15 },
    { seq: 41, startDelta: null, daysDelta: -12 },

    // ── CANCELLED (42): Only dueDate ──
    { seq: 42, startDelta: null, daysDelta: -18 },
  ];

  for (const cfg of dateConfigs) {
    const startDate = cfg.startDelta !== null
      ? new Date(now.getTime() + cfg.startDelta * dayMs).toISOString()
      : null;
    const dueDate = cfg.daysDelta !== null
      ? new Date(now.getTime() + cfg.daysDelta * dayMs).toISOString()
      : null;

    await pool.query(
      `UPDATE work_items 
       SET start_date = $1, due_date = $2, updated_at = NOW() 
       WHERE sequence_number = $3`,
      [startDate, dueDate, cfg.seq]
    );
  }

  console.log('✅ Updated all work_items dates in PostgreSQL.');

  // Flush Redis cache for work-items
  const keys = await redis.keys('flux:*');
  if (keys.length > 0) {
    await redis.del(...keys);
    console.log(`✅ Flushed ${keys.length} Redis cache keys.`);
  }

  // Summary check
  const check = await pool.query(`
    SELECT 
      count(*) as total,
      count(start_date) as has_start_date,
      count(due_date) as has_due_date,
      count(CASE WHEN start_date IS NOT NULL AND due_date IS NOT NULL THEN 1 END) as has_both_dates,
      count(CASE WHEN start_date IS NULL AND due_date IS NOT NULL THEN 1 END) as has_only_due_date,
      count(CASE WHEN start_date IS NULL AND due_date IS NULL THEN 1 END) as has_no_dates,
      count(CASE WHEN start_date IS NOT NULL AND due_date IS NULL THEN 1 END) as has_only_start_date
    FROM work_items
  `);
  console.log('📊 New Date Distribution:', check.rows[0]);

  await pool.end();
  await redis.quit();
}

standardizeDates().catch(console.error);
