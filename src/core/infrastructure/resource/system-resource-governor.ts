import { Injectable, Optional } from '@nestjs/common';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as v8 from 'node:v8';

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

/**
 * Unbounded cgroup sentinel threshold (64 TiB). Linux cgroups v1 reports
 * values near PAGE_COUNTER_MAX / INT64_MAX when no container memory limit is set.
 */
const MAX_REASONABLE_CGROUP_BYTES = 64 * 1024 * GiB;

export const RESOURCE_GOVERNOR_DEFAULTS = {
  lowWatermarkRatio: 0.7,
  highWatermarkRatio: 0.85,
  targetRecoveryRatio: 0.65,
  baseOverheadBytes: 100 * MiB,
  minUsableMemoryBytes: 32 * MiB,
  avgYjsDocBytes: 300 * KiB,
  avgAccessCacheEntryBytes: 150 * KiB,
  avgTrackedSocketBytes: 60 * KiB,
  avgIngestionJobBytes: 128 * MiB,
  avgOutboxPdfJobBytes: 96 * MiB,
  avgAiKnowledgeJobBytes: 160 * MiB,
  minCompressedIdleTtlMs: 30_000,
  criticalIdleTtlMs: 15_000,
} as const;

export interface HardwareSnapshot {
  readonly cpuCount: number;
  readonly v8HeapLimitBytes: number;
  readonly v8HeapUsedBytes: number;
  readonly rssBytes: number;
  readonly osTotalMemBytes: number;
  readonly osFreeMemBytes?: number;
  readonly cgroupMemLimitBytes: number | null;
  readonly cgroupMemUsedBytes?: number | null;
}

/**
 * Internal seam (Adapter port) for reading host/container hardware metrics.
 * Production uses `NodeHardwareResourceProbe`; tests inject a deterministic fake.
 */
export interface HardwareResourceProbe {
  readSnapshot(): HardwareSnapshot;
}

export interface SystemTierBudgets {
  readonly cpuCount: number;
  readonly memoryLimitBytes: number;
  readonly usableMemoryBytes: number;
  readonly dbPoolMax: number;
  readonly workerConcurrency: number;
  readonly ingestionConcurrency: number;
  readonly outboxConcurrency: number;
  readonly aiKnowledgeConcurrency: number;
  readonly realtimeMaxActiveDocs: number;
  readonly realtimeMaxCacheEntries: number;
  readonly realtimeMaxTrackedSockets: number;
  readonly healthHeapLimitBytes: number;
  readonly healthRssLimitBytes: number;
}

export type PressureLevel = 'normal' | 'elevated' | 'critical';

export interface ResourcePressureSnapshot {
  readonly level: PressureLevel;
  readonly memoryLimitBytes: number;
  readonly memoryUsedBytes: number;
  readonly heapUsageRatio: number;
  readonly pressureFactor: number;
  readonly shouldShedLoad: boolean;
  readonly effectiveWorkerConcurrency: number;
}

export interface EvictionAdviceParams {
  readonly activeCount: number;
  readonly baseIdleTtlMs: number;
  readonly hardCap?: number;
  readonly avgItemBytes?: number;
}

export interface EvictionAdvice {
  readonly pressure: ResourcePressureSnapshot;
  readonly effectiveIdleTtlMs: number;
  readonly effectiveHardCap: number;
  readonly targetEvictions: number;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function readCgroupMemoryLimitBytes(): number | null {
  const cgroupPaths = [
    '/sys/fs/cgroup/memory.max', // Cgroup v2
    '/sys/fs/cgroup/memory/memory.limit_in_bytes', // Cgroup v1
  ];

  for (const cgroupPath of cgroupPaths) {
    try {
      if (!fs.existsSync(cgroupPath)) continue;
      const raw = fs.readFileSync(cgroupPath, 'utf8').trim();
      if (!raw || raw === 'max') continue;
      const parsed = Number.parseInt(raw, 10);
      if (
        Number.isFinite(parsed) &&
        parsed > 0 &&
        parsed < MAX_REASONABLE_CGROUP_BYTES
      ) {
        return parsed;
      }
    } catch {
      // Ignore permission or non-Linux filesystem errors
    }
  }
  return null;
}

/**
 * Reads live container memory consumption (including all spawned `latexmk`/`pdflatex`
 * child processes in the same cgroup) directly from the Linux kernel.
 */
function readCgroupMemoryUsedBytes(): number | null {
  const cgroupUsagePaths = [
    '/sys/fs/cgroup/memory.current', // Cgroup v2
    '/sys/fs/cgroup/memory/memory.usage_in_bytes', // Cgroup v1
  ];

  for (const usagePath of cgroupUsagePaths) {
    try {
      if (!fs.existsSync(usagePath)) continue;
      const raw = fs.readFileSync(usagePath, 'utf8').trim();
      if (!raw) continue;
      const parsed = Number.parseInt(raw, 10);
      if (
        Number.isFinite(parsed) &&
        parsed >= 0 &&
        parsed < MAX_REASONABLE_CGROUP_BYTES
      ) {
        return parsed;
      }
    } catch {
      // Ignore permission or non-Linux filesystem errors
    }
  }
  return null;
}

@Injectable()
export class NodeHardwareResourceProbe implements HardwareResourceProbe {
  private readonly cachedCgroupLimitBytes: number | null;
  private readonly cachedCpuCount: number;

  constructor() {
    this.cachedCgroupLimitBytes = readCgroupMemoryLimitBytes();
    const rawCpu =
      typeof os.availableParallelism === 'function'
        ? os.availableParallelism()
        : os.cpus().length;
    this.cachedCpuCount = Math.max(1, rawCpu || 1);
  }

  public readSnapshot(): HardwareSnapshot {
    const heapStats = v8.getHeapStatistics();
    const memUsage = process.memoryUsage();
    return {
      cpuCount: this.cachedCpuCount,
      v8HeapLimitBytes: heapStats.heap_size_limit,
      v8HeapUsedBytes: memUsage.heapUsed,
      rssBytes: memUsage.rss,
      osTotalMemBytes: os.totalmem(),
      osFreeMemBytes: os.freemem(),
      cgroupMemLimitBytes: this.cachedCgroupLimitBytes,
      cgroupMemUsedBytes: readCgroupMemoryUsedBytes(),
    };
  }
}

/**
 * Deep module governing hardware-proportional resource budgets and Envoy-style
 * memory watermarks across Web API, Background Workers, and Realtime services.
 */
@Injectable()
export class SystemResourceGovernor {
  private readonly probe: HardwareResourceProbe;

  constructor(@Optional() probe?: HardwareResourceProbe) {
    this.probe = probe ?? new NodeHardwareResourceProbe();
  }

  public readHardwareSnapshot(): HardwareSnapshot {
    return this.probe.readSnapshot();
  }

  public getTierBudgets(): SystemTierBudgets {
    const snap = this.probe.readSnapshot();
    const cpuCount = Math.max(1, snap.cpuCount || 1);
    const memoryLimitBytes = this.resolveEffectiveMemoryLimit(snap);

    const usableMemoryBytes = Math.max(
      RESOURCE_GOVERNOR_DEFAULTS.minUsableMemoryBytes,
      Math.floor(
        memoryLimitBytes * RESOURCE_GOVERNOR_DEFAULTS.lowWatermarkRatio -
          RESOURCE_GOVERNOR_DEFAULTS.baseOverheadBytes,
      ),
    );

    // Reserve 1 core for event loop & I/O responsiveness on multi-core hosts
    const workerConcurrency = clampInt(Math.max(1, cpuCount - 1), 1, 16);

    // Coordinate Library Metadata Ingestion, PDF Outbox Extraction, and AI Knowledge Ingest
    // by both CPU parallelism and available memory so concurrent PDF buffers cannot OOM the worker
    const ingestionConcurrency = clampInt(
      Math.min(
        Math.max(1, Math.floor(cpuCount * 0.75)),
        Math.max(
          1,
          Math.floor(
            usableMemoryBytes / RESOURCE_GOVERNOR_DEFAULTS.avgIngestionJobBytes,
          ),
        ),
      ),
      1,
      12,
    );

    const outboxConcurrency = clampInt(
      Math.min(
        Math.max(1, cpuCount),
        Math.max(
          1,
          Math.floor(
            usableMemoryBytes / RESOURCE_GOVERNOR_DEFAULTS.avgOutboxPdfJobBytes,
          ),
        ),
      ),
      1,
      16,
    );

    const aiKnowledgeConcurrency = clampInt(
      Math.min(
        Math.max(1, Math.floor(cpuCount * 0.5)),
        Math.max(
          1,
          Math.floor(
            usableMemoryBytes /
              RESOURCE_GOVERNOR_DEFAULTS.avgAiKnowledgeJobBytes,
          ),
        ),
      ),
      1,
      8,
    );

    const totalWorkerSlots =
      workerConcurrency +
      ingestionConcurrency +
      outboxConcurrency +
      aiKnowledgeConcurrency;

    // HikariCP formula (CPU * 2) + 1, guaranteed >= totalWorkerSlots + 2 to prevent DB pool starvation
    const dbPoolMax = clampInt(
      Math.max(cpuCount * 2 + 1, totalWorkerSlots + 2),
      5,
      50,
    );

    const realtimeMaxActiveDocs = clampInt(
      usableMemoryBytes / RESOURCE_GOVERNOR_DEFAULTS.avgYjsDocBytes,
      100,
      20_000,
    );

    const realtimeMaxCacheEntries = clampInt(
      usableMemoryBytes / RESOURCE_GOVERNOR_DEFAULTS.avgAccessCacheEntryBytes,
      250,
      50_000,
    );

    const realtimeMaxTrackedSockets = clampInt(
      usableMemoryBytes / RESOURCE_GOVERNOR_DEFAULTS.avgTrackedSocketBytes,
      500,
      100_000,
    );

    const healthHeapLimitBytes = Math.floor(
      memoryLimitBytes * RESOURCE_GOVERNOR_DEFAULTS.highWatermarkRatio,
    );
    const healthRssLimitBytes = Math.floor(
      Math.max(memoryLimitBytes, snap.v8HeapLimitBytes) * 0.9,
    );

    return {
      cpuCount,
      memoryLimitBytes,
      usableMemoryBytes,
      dbPoolMax,
      workerConcurrency,
      ingestionConcurrency,
      outboxConcurrency,
      aiKnowledgeConcurrency,
      realtimeMaxActiveDocs,
      realtimeMaxCacheEntries,
      realtimeMaxTrackedSockets,
      healthHeapLimitBytes,
      healthRssLimitBytes,
    };
  }

  public assessPressure(): ResourcePressureSnapshot {
    const snap = this.probe.readSnapshot();
    const budgets = this.getTierBudgets();
    const memoryLimitBytes = budgets.memoryLimitBytes;
    const memoryUsedBytes = Math.max(
      snap.v8HeapUsedBytes,
      snap.cgroupMemLimitBytes !== null
        ? Math.min(snap.rssBytes, snap.v8HeapUsedBytes)
        : snap.v8HeapUsedBytes,
    );

    const heapUsageRatio =
      memoryLimitBytes > 0 ? memoryUsedBytes / memoryLimitBytes : 0;

    const low = RESOURCE_GOVERNOR_DEFAULTS.lowWatermarkRatio;
    const high = RESOURCE_GOVERNOR_DEFAULTS.highWatermarkRatio;

    let level: PressureLevel = 'normal';
    let pressureFactor = 0;

    if (heapUsageRatio >= high) {
      level = 'critical';
      pressureFactor = 1;
    } else if (heapUsageRatio >= low) {
      level = 'elevated';
      pressureFactor = (heapUsageRatio - low) / (high - low);
    }

    const shouldShedLoad = level === 'critical';
    const effectiveWorkerConcurrency =
      level === 'critical'
        ? 1
        : level === 'elevated'
          ? Math.max(
              1,
              Math.floor(
                budgets.workerConcurrency * (1 - pressureFactor * 0.5),
              ),
            )
          : budgets.workerConcurrency;

    return {
      level,
      memoryLimitBytes,
      memoryUsedBytes,
      heapUsageRatio,
      pressureFactor,
      shouldShedLoad,
      effectiveWorkerConcurrency,
    };
  }

  public adviseEviction(params: EvictionAdviceParams): EvictionAdvice {
    const budgets = this.getTierBudgets();
    const pressure = this.assessPressure();
    const effectiveHardCap =
      params.hardCap && params.hardCap > 0
        ? params.hardCap
        : budgets.realtimeMaxActiveDocs;
    const avgItemBytes =
      params.avgItemBytes && params.avgItemBytes > 0
        ? params.avgItemBytes
        : RESOURCE_GOVERNOR_DEFAULTS.avgYjsDocBytes;

    let effectiveIdleTtlMs = params.baseIdleTtlMs;
    if (pressure.level === 'critical') {
      effectiveIdleTtlMs = Math.min(
        params.baseIdleTtlMs,
        RESOURCE_GOVERNOR_DEFAULTS.criticalIdleTtlMs,
      );
    } else if (pressure.level === 'elevated') {
      const floorTtl = Math.min(
        params.baseIdleTtlMs,
        RESOURCE_GOVERNOR_DEFAULTS.minCompressedIdleTtlMs,
      );
      effectiveIdleTtlMs = Math.floor(
        params.baseIdleTtlMs -
          pressure.pressureFactor * (params.baseIdleTtlMs - floorTtl),
      );
    }

    const countOverflow = Math.max(0, params.activeCount - effectiveHardCap);

    let memoryOverflow = 0;
    if (pressure.level !== 'normal' && params.activeCount > 0) {
      const targetRecoveryBytes = Math.floor(
        pressure.memoryLimitBytes *
          RESOURCE_GOVERNOR_DEFAULTS.targetRecoveryRatio,
      );
      const excessBytes = Math.max(
        0,
        pressure.memoryUsedBytes - targetRecoveryBytes,
      );
      memoryOverflow = Math.ceil(excessBytes / avgItemBytes);
    }

    const targetEvictions = Math.min(
      params.activeCount,
      Math.max(countOverflow, memoryOverflow),
    );

    return {
      pressure,
      effectiveIdleTtlMs,
      effectiveHardCap,
      targetEvictions,
    };
  }

  private resolveEffectiveMemoryLimit(snap: HardwareSnapshot): number {
    const candidates = [snap.v8HeapLimitBytes, snap.osTotalMemBytes].filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
    );
    if (
      snap.cgroupMemLimitBytes !== null &&
      Number.isFinite(snap.cgroupMemLimitBytes) &&
      snap.cgroupMemLimitBytes > 0
    ) {
      candidates.push(snap.cgroupMemLimitBytes);
    }
    return candidates.length > 0 ? Math.min(...candidates) : 512 * MiB;
  }
}

const defaultGovernor = new SystemResourceGovernor();

export function getDefaultResourceGovernor(): SystemResourceGovernor {
  return defaultGovernor;
}
