import {
  SystemResourceGovernor,
  type HardwareResourceProbe,
  type HardwareSnapshot,
} from '@/core/infrastructure/resource/system-resource-governor';
import { PagesRealtimeConfigService } from '@/modules/realtime/channels/pages/config';
import { YjsService } from '@/modules/realtime/channels/pages/yjs/engine';
import { YjsUpdateValidator } from '@/modules/realtime/channels/pages/yjs/sync';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function createFakeProbe(
  initial: Partial<HardwareSnapshot> = {},
): HardwareResourceProbe & { update(patch: Partial<HardwareSnapshot>): void } {
  let state: HardwareSnapshot = {
    cpuCount: 4,
    v8HeapLimitBytes: 1024 * MiB,
    v8HeapUsedBytes: 300 * MiB,
    rssBytes: 400 * MiB,
    osTotalMemBytes: 8 * GiB,
    cgroupMemLimitBytes: null,
    ...initial,
  };

  return {
    readSnapshot: () => ({ ...state }),
    update: (patch: Partial<HardwareSnapshot>) => {
      state = { ...state, ...patch };
    },
  };
}

describe('SystemResourceGovernor — Deep Module Seam Tests', () => {
  describe('1. Cgroup-Aware Hardware Auto-Sizing Across 512MB, 4GB, and 16GB Profiles', () => {
    it('scales DB pool (HikariCP), worker concurrency, and Yjs doc capacity from a small 512MB / 2-CPU container up to a 4GB / 8-CPU container', () => {
      const smallProbe = createFakeProbe({
        cpuCount: 2,
        v8HeapLimitBytes: 512 * MiB,
        v8HeapUsedBytes: 180 * MiB,
        rssBytes: 220 * MiB,
        osTotalMemBytes: 4 * GiB,
        cgroupMemLimitBytes: 512 * MiB,
      });
      const smallGov = new SystemResourceGovernor(smallProbe);
      const smallBudgets = smallGov.getTierBudgets();

      // Worker concurrency: max(1, 2 - 1) = 1
      expect(smallBudgets.workerConcurrency).toBe(1);
      expect(smallBudgets.ingestionConcurrency).toBeGreaterThanOrEqual(1);
      expect(smallBudgets.outboxConcurrency).toBeGreaterThanOrEqual(1);
      expect(smallBudgets.aiKnowledgeConcurrency).toBe(1);
      // Total heavy background slots on 2-CPU / 512MB must stay bounded (<= 6) and strictly below dbPoolMax
      const smallTotalWorkerSlots =
        smallBudgets.workerConcurrency +
        smallBudgets.ingestionConcurrency +
        smallBudgets.outboxConcurrency +
        smallBudgets.aiKnowledgeConcurrency;
      expect(smallTotalWorkerSlots).toBeLessThanOrEqual(6);
      expect(smallBudgets.dbPoolMax).toBeGreaterThanOrEqual(
        smallTotalWorkerSlots + 2,
      );
      // Usable RAM at 70% of 512MB minus 100MB base = ~258.4MB -> / 300KB = ~882 docs
      expect(smallBudgets.realtimeMaxActiveDocs).toBeGreaterThanOrEqual(800);
      expect(smallBudgets.realtimeMaxActiveDocs).toBeLessThanOrEqual(950);

      const largeProbe = createFakeProbe({
        cpuCount: 8,
        v8HeapLimitBytes: 4096 * MiB,
        v8HeapUsedBytes: 500 * MiB,
        rssBytes: 700 * MiB,
        osTotalMemBytes: 16 * GiB,
        cgroupMemLimitBytes: 2560 * MiB, // Container cgroup cap is tighter than V8 default
      });
      const largeGov = new SystemResourceGovernor(largeProbe);
      const largeBudgets = largeGov.getTierBudgets();

      // Worker concurrency: max(1, 8 - 1) = 7
      expect(largeBudgets.workerConcurrency).toBe(7);
      expect(largeBudgets.ingestionConcurrency).toBeGreaterThan(
        smallBudgets.ingestionConcurrency,
      );
      expect(largeBudgets.outboxConcurrency).toBeGreaterThan(
        smallBudgets.outboxConcurrency,
      );
      expect(largeBudgets.aiKnowledgeConcurrency).toBeGreaterThan(
        smallBudgets.aiKnowledgeConcurrency,
      );
      const largeTotalWorkerSlots =
        largeBudgets.workerConcurrency +
        largeBudgets.ingestionConcurrency +
        largeBudgets.outboxConcurrency +
        largeBudgets.aiKnowledgeConcurrency;
      expect(largeBudgets.dbPoolMax).toBeGreaterThanOrEqual(
        largeTotalWorkerSlots + 2,
      );
      // Effective limit respects the 2560MB cgroup cap over 4096MB V8 heap limit
      expect(largeBudgets.memoryLimitBytes).toBe(2560 * MiB);
      expect(largeBudgets.realtimeMaxActiveDocs).toBeGreaterThan(
        smallBudgets.realtimeMaxActiveDocs * 5,
      );
      expect(largeBudgets.healthHeapLimitBytes).toBe(
        Math.floor(2560 * MiB * 0.85),
      );
    });
  });

  describe('2. Envoy-Style Memory Watermarks (70% Low / 85% High) & Adaptive Eviction Advice', () => {
    it('keeps full idle TTL in normal zone (<70%), linearly compresses TTL and computes LRU evictions in elevated zone (70-85%), and triggers load shedding in critical zone (>=85%)', () => {
      const probe = createFakeProbe({
        cpuCount: 4,
        v8HeapLimitBytes: 1000 * MiB,
        v8HeapUsedBytes: 450 * MiB, // 45% -> NORMAL
        rssBytes: 500 * MiB,
      });
      const governor = new SystemResourceGovernor(probe);
      const baseIdleTtlMs = 15 * 60 * 1000; // 15 minutes

      // 1. Normal Zone (45% RAM)
      const normalPressure = governor.assessPressure();
      expect(normalPressure.level).toBe('normal');
      expect(normalPressure.pressureFactor).toBe(0);
      expect(normalPressure.shouldShedLoad).toBe(false);

      const normalAdvice = governor.adviseEviction({
        activeCount: 400,
        baseIdleTtlMs,
        hardCap: 2000,
      });
      expect(normalAdvice.effectiveIdleTtlMs).toBe(baseIdleTtlMs);
      expect(normalAdvice.targetEvictions).toBe(0);

      // 2. Elevated Zone (77.5% RAM -> halfway between 70% and 85%, pressureFactor = 0.5)
      probe.update({
        v8HeapUsedBytes: 775 * MiB,
        rssBytes: 800 * MiB,
      });
      const elevatedPressure = governor.assessPressure();
      expect(elevatedPressure.level).toBe('elevated');
      expect(elevatedPressure.pressureFactor).toBeCloseTo(0.5, 2);
      expect(elevatedPressure.shouldShedLoad).toBe(false);

      const elevatedAdvice = governor.adviseEviction({
        activeCount: 600,
        baseIdleTtlMs,
        hardCap: 2000,
      });
      expect(elevatedAdvice.effectiveIdleTtlMs).toBeLessThan(baseIdleTtlMs);
      expect(elevatedAdvice.effectiveIdleTtlMs).toBeGreaterThan(15_000);
      // Even though activeCount (600) < hardCap (2000), memory exceeds 70% watermark so LRU evictions are advised!
      expect(elevatedAdvice.targetEvictions).toBeGreaterThan(0);

      // 3. Critical Zone (90% RAM -> >= 85% High Watermark)
      probe.update({
        v8HeapUsedBytes: 900 * MiB,
        rssBytes: 920 * MiB,
      });
      const criticalPressure = governor.assessPressure();
      expect(criticalPressure.level).toBe('critical');
      expect(criticalPressure.pressureFactor).toBe(1);
      expect(criticalPressure.shouldShedLoad).toBe(true);
      expect(criticalPressure.effectiveWorkerConcurrency).toBe(1);

      const criticalAdvice = governor.adviseEviction({
        activeCount: 600,
        baseIdleTtlMs,
        hardCap: 2000,
      });
      expect(criticalAdvice.effectiveIdleTtlMs).toBe(15_000);
      expect(criticalAdvice.targetEvictions).toBeGreaterThan(
        elevatedAdvice.targetEvictions,
      );
    });
  });

  describe('3. YjsService Integration with SystemResourceGovernor Watermark Eviction', () => {
    it('evicts idle and LRU Y.Docs when memory crosses the 70% watermark even before reaching static maxActiveDocs', async () => {
      const probe = createFakeProbe({
        cpuCount: 2,
        v8HeapLimitBytes: 512 * MiB,
        v8HeapUsedBytes: 200 * MiB, // Normal initially
        rssBytes: 240 * MiB,
      });
      const governor = new SystemResourceGovernor(probe);
      const pagesConfig = new PagesRealtimeConfigService(
        undefined,
        undefined,
        governor,
      );
      const yjsService = new YjsService(
        undefined,
        undefined,
        new YjsUpdateValidator(),
        pagesConfig,
        governor,
      );

      try {
        const s1 = await yjsService.getOrCreateDoc('proj-1', 'doc-1');
        const s2 = await yjsService.getOrCreateDoc('proj-1', 'doc-2');
        const s3 = await yjsService.getOrCreateDoc('proj-1', 'doc-3');

        // Age doc-1 by 3 minutes (180s): under normal 15-min TTL it would stay,
        // but under critical memory pressure (TTL compressed to 15s) it gets swept!
        s1.lastActiveAt = Date.now() - 180_000;
        s2.lastActiveAt = Date.now() - 5_000;
        s3.lastActiveAt = Date.now() - 1_000;

        // Simulate memory spike to 88% (Critical zone)
        probe.update({
          v8HeapUsedBytes: Math.floor(512 * MiB * 0.88),
          rssBytes: Math.floor(512 * MiB * 0.9),
        });

        const evicted = await yjsService.sweepIdleDocs();
        expect(evicted).toBeGreaterThanOrEqual(1);
        expect(yjsService.isActive('proj-1', 'doc-1')).toBe(false);
      } finally {
        await yjsService.onModuleDestroy();
      }
    });
  });
});
