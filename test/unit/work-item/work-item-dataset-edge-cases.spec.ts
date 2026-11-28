import {
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { fromPartial } from '@total-typescript/shoehorn';
import { ArchiveRepository } from '@/modules/project/work-item/archive/archive.repository';
import { ArchiveService } from '@/modules/project/work-item/archive/archive.service';
import { AssignmentRepository } from '@/modules/project/work-item/assignment/assignment.repository';
import { AssignmentService } from '@/modules/project/work-item/assignment/assignment.service';
import { CoreRepository } from '@/modules/project/work-item/core/core.repository';
import { CoreService } from '@/modules/project/work-item/core/core.service';
import { BulkHandler } from '@/modules/project/work-item/core/handlers/bulk.handler';
import { CloneHandler } from '@/modules/project/work-item/core/handlers/clone.handler';
import { EventHandler } from '@/modules/project/work-item/core/handlers/event.handler';
import { IdHandler } from '@/modules/project/work-item/core/handlers/id.handler';
import { RankHandler } from '@/modules/project/work-item/core/handlers/rank.handler';
import { validateHierarchyCycle } from '@/modules/project/work-item/core/utils/core.util';
import { HistoryRepository } from '@/modules/project/work-item/history/history.repository';
import {
  HistoryService,
  summarizeDiff,
} from '@/modules/project/work-item/history/history.service';
import { RelationRepository } from '@/modules/project/work-item/relation/relation.repository';
import { RelationService } from '@/modules/project/work-item/relation/relation.service';

interface MockGraphItem {
  id: string;
  identifier?: string;
  title: string;
  projectId: string;
  startDate?: Date;
  dueDate?: Date;
  relations: Array<{
    id: string;
    targetWorkItemId: string;
    type: string;
    createdAt: string;
  }>;
  outgoingRelations?: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    type: string;
    createdAt: Date;
  }>;
}

describe('Work-Item DAG Cycles, CPM Scheduling, RankHandler, OCC & 42-Item Benchmark', () => {
  describe('RelationService DAG Cycle Detection & Temporal CPM Violations', () => {
    let relationService: RelationService;
    let itemStore: Map<string, MockGraphItem>;
    let edgeStore: Array<{ sourceId: string; targetId: string; type: string }>;
    let upsertSpy: jest.Mock;

    beforeEach(() => {
      itemStore = new Map();
      edgeStore = [];

      for (let i = 1; i <= 6; i++) {
        const id = `00000000-0000-4000-8000-00000000000${i}`;
        const item: MockGraphItem = {
          id,
          identifier: `FLUX-${i}`,
          title: `Research Milestone ${i}`,
          projectId: 'proj-flux-1',
          relations: [],
        };
        itemStore.set(id, item);
        itemStore.set(`FLUX-${i}`, item);
      }

      upsertSpy = jest.fn(
        async ({
          create,
        }: {
          create: { sourceId: string; targetId: string; type: string };
        }) => {
          edgeStore.push({
            sourceId: create.sourceId,
            targetId: create.targetId,
            type: create.type,
          });
          const src = itemStore.get(create.sourceId);
          if (src) {
            src.outgoingRelations ??= [];
            src.outgoingRelations.push({
              id: `rel-${edgeStore.length}`,
              sourceId: create.sourceId,
              targetId: create.targetId,
              type: create.type,
              createdAt: new Date(),
            });
          }
          return create;
        },
      );

      const mockPrisma: Record<string, unknown> = {
        $transaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) =>
          cb(mockPrisma),
        ),
        workItem: {
          findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
            itemStore.get(where.id) ?? null,
          ),
          update: jest.fn(
            async ({
              where,
              data,
            }: {
              where: { id: string };
              data: { relations?: MockGraphItem['relations'] };
            }) => {
              const existing = itemStore.get(where.id);
              if (existing && data.relations) existing.relations = data.relations;
              return existing;
            },
          ),
        },
        workItemRelation: {
          findMany: jest.fn().mockResolvedValue([]),
          upsert: upsertSpy,
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };

      relationService = new RelationService(
        fromPartial<RelationRepository>({
          prisma: mockPrisma as never,
          findWorkItem: jest.fn(
            async (idOrIdentifier: string) =>
              itemStore.get(idOrIdentifier) ?? null,
          ) as never,
          findWorkItemsByIds: jest.fn(async (ids: string[]) =>
            ids
              .map((id) => itemStore.get(id))
              .filter((x): x is MockGraphItem => Boolean(x)),
          ) as never,
          findProjectGraphEdges: jest.fn(
            async (_projectId: string, category: 'blocks' | 'duplicate_of') => {
              const isBlocks = category === 'blocks';
              const forward = isBlocks
                ? [
                    'blocks',
                    'FINISH_TO_START',
                    'START_TO_START',
                    'FINISH_TO_FINISH',
                    'START_TO_FINISH',
                    'starts_before',
                    'finishes_before',
                  ]
                : ['duplicate_of'];
              const inverse = isBlocks
                ? ['blocked_by', 'starts_after', 'finishes_after']
                : ['duplicated_by'];

              return edgeStore.flatMap((e) => {
                if (forward.includes(e.type)) {
                  return [{ sourceId: e.sourceId, targetId: e.targetId }];
                }
                if (inverse.includes(e.type)) {
                  return [{ sourceId: e.targetId, targetId: e.sourceId }];
                }
                return [];
              });
            },
          ),
        }),
      );
    });

    it('detects direct, 5-hop transitive, mixed PMI CPM (FS/SS/FF/SF), and duplicate_of cycles, plus self-loops, duplicates, and cross-project links', async () => {
      // Self-loop
      await expect(
        relationService.addRelation('FLUX-1', {
          targetWorkItemId: 'FLUX-1',
          type: 'blocks',
        }),
      ).rejects.toThrow(BadRequestException);

      // Valid non-cyclic + duplicate ConflictException
      const added = await relationService.addRelation('FLUX-1', {
        targetWorkItemId: 'FLUX-2',
        type: 'blocks',
      });
      expect(added.success).toBe(true);
      expect(upsertSpy).toHaveBeenCalledTimes(1);

      await expect(
        relationService.addRelation('FLUX-1', {
          targetWorkItemId: 'FLUX-2',
          type: 'blocks',
        }),
      ).rejects.toThrow(ConflictException);

      // Direct reverse cycle (2 -> 1)
      await expect(
        relationService.addRelation('FLUX-2', {
          targetWorkItemId: 'FLUX-1',
          type: 'blocks',
        }),
      ).rejects.toThrow('Circular dependency detected');

      // 5-hop mixed CPM chain: 1 -> 2 -> 3 -> 4 -> 5
      await relationService.addRelation('FLUX-2', {
        targetWorkItemId: 'FLUX-3',
        type: 'START_TO_START',
      });
      await relationService.addRelation('FLUX-3', {
        targetWorkItemId: 'FLUX-4',
        type: 'FINISH_TO_FINISH',
      });
      await relationService.addRelation('FLUX-4', {
        targetWorkItemId: 'FLUX-5',
        type: 'START_TO_FINISH',
      });

      await expect(
        relationService.addRelation('FLUX-5', {
          targetWorkItemId: 'FLUX-1',
          type: 'blocks',
        }),
      ).rejects.toThrow(BadRequestException);

      // Inverse blocked_by equivalent of 5 -> 1
      await expect(
        relationService.addRelation('FLUX-1', {
          targetWorkItemId: 'FLUX-5',
          type: 'blocked_by',
        }),
      ).rejects.toThrow(BadRequestException);

      // duplicate_of cycle
      await relationService.addRelation('FLUX-1', {
        targetWorkItemId: 'FLUX-6',
        type: 'duplicate_of',
      });
      await expect(
        relationService.addRelation('FLUX-6', {
          targetWorkItemId: 'FLUX-1',
          type: 'duplicate_of',
        }),
      ).rejects.toThrow('Circular dependency detected');

      // Cross-project link rejected
      const external: MockGraphItem = {
        id: '00000000-0000-4000-8000-999999999999',
        identifier: 'EXT-1',
        title: 'External Issue',
        projectId: 'proj-external-99',
        relations: [],
      };
      itemStore.set(external.id, external);
      itemStore.set('EXT-1', external);

      await expect(
        relationService.addRelation('FLUX-1', {
          targetWorkItemId: 'EXT-1',
          type: 'relates_to',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('detects Temporal & CPM violations across FS, SS, FF, SF, leap-year 2028-02-29, and exact midnight hand-offs', async () => {
      const nowIso = new Date().toISOString();
      itemStore.set('pred-1', {
        id: 'pred-1',
        title: 'Predecessor Task',
        projectId: 'proj-flux-1',
        startDate: new Date('2028-02-29T00:00:00.000Z'),
        dueDate: new Date('2026-10-15T00:00:00.000Z'),
        relations: [
          { id: 'rel-fs', targetWorkItemId: 'succ-fs', type: 'FINISH_TO_START', createdAt: nowIso },
          { id: 'rel-ss', targetWorkItemId: 'succ-ss', type: 'START_TO_START', createdAt: nowIso },
          { id: 'rel-ff', targetWorkItemId: 'succ-ff', type: 'FINISH_TO_FINISH', createdAt: nowIso },
          { id: 'rel-sf', targetWorkItemId: 'succ-sf', type: 'START_TO_FINISH', createdAt: nowIso },
          { id: 'rel-ok', targetWorkItemId: 'succ-ok', type: 'blocks', createdAt: nowIso },
        ],
      });

      const targets: Record<string, MockGraphItem> = {
        'succ-fs': {
          id: 'succ-fs',
          title: 'FS',
          projectId: 'proj-flux-1',
          startDate: new Date('2026-10-14T23:59:59.999Z'),
          dueDate: new Date('2026-10-20T00:00:00.000Z'),
          relations: [],
        },
        'succ-ss': {
          id: 'succ-ss',
          title: 'SS Leap',
          projectId: 'proj-flux-1',
          startDate: new Date('2028-02-28T23:59:59.999Z'),
          dueDate: new Date('2028-03-05T00:00:00.000Z'),
          relations: [],
        },
        'succ-ff': {
          id: 'succ-ff',
          title: 'FF',
          projectId: 'proj-flux-1',
          startDate: new Date('2026-10-10T00:00:00.000Z'),
          dueDate: new Date('2026-10-14T23:59:59.999Z'),
          relations: [],
        },
        'succ-sf': {
          id: 'succ-sf',
          title: 'SF',
          projectId: 'proj-flux-1',
          startDate: new Date('2028-02-20T00:00:00.000Z'),
          dueDate: new Date('2028-02-28T23:59:59.999Z'),
          relations: [],
        },
        'succ-ok': {
          id: 'succ-ok',
          title: 'Exact Handoff',
          projectId: 'proj-flux-1',
          startDate: new Date('2026-10-15T00:00:00.000Z'),
          dueDate: new Date('2026-10-20T00:00:00.000Z'),
          relations: [],
        },
      };
      for (const [k, v] of Object.entries(targets)) itemStore.set(k, v);

      const { violations } = await relationService.getViolatedRelations('pred-1');
      const byId = new Map(violations.map((v) => [v.relationId, v.isViolated]));
      expect(byId.get('rel-fs')).toBe(true);
      expect(byId.get('rel-ss')).toBe(true);
      expect(byId.get('rel-ff')).toBe(true);
      expect(byId.get('rel-sf')).toBe(true);
      expect(byId.get('rel-ok')).toBe(false);
    });
  });

  describe('Sub-Issue Hierarchy, RankHandler, Canonical Bulk Ops & OCC', () => {
    it('enforces self-parenting, circular descendant parenting, 10-level depth cap, and convertToRootWorkItem', async () => {
      const UUID_1 = '11111111-1111-4111-8111-111111111111';
      const UUID_2 = '22222222-2222-4222-8222-222222222222';
      const UUID_3 = '33333333-3333-4333-8333-333333333333';

      const itemMap = new Map([
        [UUID_1, { id: UUID_1, identifier: 'FLUX-1', title: 'Root', projectId: 'proj-1', parentWorkItemId: null }],
        [UUID_2, { id: UUID_2, identifier: 'FLUX-2', title: 'Child', projectId: 'proj-1', parentWorkItemId: UUID_1 }],
        [UUID_3, { id: UUID_3, identifier: 'FLUX-3', title: 'Grandchild', projectId: 'proj-1', parentWorkItemId: UUID_2 }],
      ]);

      const disconnectParentWorkItem = jest.fn(async (id: string) => ({
        ...itemMap.get(id)!,
        parentWorkItemId: null,
        parentWorkItem: null,
      }));

      const coreService = new CoreService(
        fromPartial<CoreRepository>({
          findWorkItemById: jest.fn(async (id: string) => itemMap.get(id) ?? null) as never,
          updateWorkItem: jest.fn(async (id: string, data: Record<string, unknown>) => ({
            ...itemMap.get(id),
            ...data,
          })) as never,
          disconnectParentWorkItem: disconnectParentWorkItem as never,
          findLabelsByIds: jest.fn().mockResolvedValue([]),
        }),
        fromPartial<IdHandler>({}),
        new RankHandler(),
        fromPartial<CloneHandler>({}),
        fromPartial<EventHandler>({ dispatchUpdateEvents: jest.fn() }),
      );

      await expect(
        coreService.updateWorkItem(UUID_1, { parentWorkItemId: UUID_1 }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        coreService.updateWorkItem(UUID_1, { parentWorkItemId: UUID_3 }),
      ).rejects.toThrow(BadRequestException);

      const converted = await coreService.convertToRootWorkItem(UUID_2);
      expect(converted.workItem?.parentWorkItemId).toBeNull();
      expect(disconnectParentWorkItem).toHaveBeenCalledWith(UUID_2);

      const deepItems = new Map<string, { id: string; projectId: string; parentWorkItemId: string | null }>();
      for (let i = 1; i <= 12; i++) {
        deepItems.set(`node-${i}`, {
          id: `node-${i}`,
          projectId: 'proj-1',
          parentWorkItemId: i > 1 ? `node-${i - 1}` : null,
        });
      }
      await expect(
        validateHierarchyCycle(
          'node-new',
          deepItems.get('node-12')!,
          async (id) => deepItems.get(id) ?? null,
          10,
        ),
      ).rejects.toThrow('Hierarchy depth cannot exceed 10 levels');
    });

    it('updates only dirty rows on reorder, clamps out-of-bounds ranks, computes midpoints, and rebalances on precision exhaustion (< 0.0001)', () => {
      const rankHandler = new RankHandler();

      // Same-column dirty-row optimization
      const colA = [0, 1, 2, 3, 4].map((r) => ({
        id: `item-${r}`,
        columnId: 'col-A',
        rank: r,
      }));
      const sameColUpdates = rankHandler.calculateReorder(
        colA,
        'item-1',
        'col-A',
        3,
        () => false,
      );
      expect(sameColUpdates.map((u) => [u.id, u.rank])).toEqual([
        ['item-2', 1],
        ['item-3', 2],
        ['item-1', 3],
      ]);

      // Cross-column suffix shift
      const colB = [0, 1, 2].map((r) => ({
        id: `b-${r}`,
        columnId: 'col-B',
        rank: r,
      }));
      const crossUpdates = rankHandler.calculateReorder(
        colB,
        'a-9',
        'col-B',
        1,
        () => true,
        { id: 'a-9', columnId: 'col-A', rank: 0 },
      );
      expect(crossUpdates).toHaveLength(3);
      expect(crossUpdates.find((u) => u.id === 'a-9')).toMatchObject({
        rank: 1,
        columnId: 'col-B',
        completed: true,
      });
      expect(crossUpdates.find((u) => u.id === 'b-0')).toBeUndefined();

      // Out-of-bounds rank clamp
      const clamped = rankHandler.calculateReorder(
        [
          { id: 'item-0', columnId: 'col-A', rank: 0 },
          { id: 'item-1', columnId: 'col-A', rank: 1 },
        ],
        'item-0',
        'col-A',
        999,
        () => false,
      );
      expect(clamped.find((u) => u.id === 'item-0')?.rank).toBe(1);
      expect(clamped.find((u) => u.id === 'item-1')?.rank).toBe(0);

      // Midpoint edge cases
      expect(rankHandler.computeMidpointRank(null, null)).toEqual({
        rank: 1000,
        needsRebalance: false,
      });
      expect(rankHandler.computeMidpointRank(null, 1000).rank).toBe(500);
      expect(rankHandler.computeMidpointRank(3000, null).rank).toBe(4000);

      // Precision exhaustion across 50 sequential insertions between 1000 and 1001
      const items = [
        { id: 'anchor-low', columnId: 'todo', rank: 1000 },
        { id: 'anchor-high', columnId: 'todo', rank: 1001 },
      ];
      let low = 1000;
      let rebalancedCount = 0;

      for (let step = 1; step <= 50; step++) {
        const newId = `inserted-${step}`;
        const res = rankHandler.calculateFractionalReorder(
          items,
          newId,
          'todo',
          low,
          1001,
          () => false,
          { id: newId, columnId: 'todo', rank: 0 },
        );
        if (res.rebalanced) {
          rebalancedCount += 1;
          items.length = 0;
          for (const u of res.updates) {
            items.push({ id: u.id, columnId: u.columnId, rank: u.rank });
          }
          expect(items[0].rank).toBe(1000);
          expect(items[1].rank).toBe(2000);
          low = items[0].rank;
        } else {
          items.push({ id: newId, columnId: 'todo', rank: res.rank });
          low = res.rank;
        }
      }

      expect(rebalancedCount).toBeGreaterThanOrEqual(1);
      expect(new Set(items.map((i) => i.rank)).size).toBe(items.length);
    });

    it('deduplicates & canonically sorts bulk IDs and enforces Optimistic Concurrency Control (expectedUpdatedAt)', async () => {
      const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const PROJ_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

      const bulkUpdateWorkItems = jest.fn().mockResolvedValue({ count: 2 });
      const bulkHandler = new BulkHandler(
        fromPartial<CoreRepository>({
          findProjectWithStates: jest.fn().mockResolvedValue({
            id: PROJ_ID,
            states: [{ id: 'done', name: 'Done', group: 'completed' }],
          }),
          bulkUpdateWorkItems,
        }),
        fromPartial<EventHandler>({
          emitBulkUpdated: jest.fn(),
          emitBulkDeleted: jest.fn(),
        }),
      );
      await bulkHandler.bulkUpdate(
        PROJ_ID,
        { workItemIds: [ID_B, ID_A, ID_B, ID_A], data: { columnId: 'done' } },
        'user-1',
      );
      expect(bulkUpdateWorkItems).toHaveBeenCalledWith(
        PROJ_ID,
        [ID_A, ID_B],
        expect.objectContaining({ columnId: 'done', completed: true }),
      );

      const bulkArchive = jest.fn().mockResolvedValue({ count: 2 });
      const archiveService = new ArchiveService(
        fromPartial<ArchiveRepository>({
          findWorkItemsByIds: jest.fn().mockResolvedValue([
            { id: ID_A, projectId: PROJ_ID },
            { id: ID_B, projectId: PROJ_ID },
          ]),
          bulkArchive,
        }),
      );
      await archiveService.bulkArchive({ workItemIds: [ID_B, ID_A, ID_B] }, 'user-1');
      expect(bulkArchive).toHaveBeenCalledWith([ID_A, ID_B]);

      const bulkAssignWorkItems = jest.fn().mockResolvedValue(2);
      const assignmentService = new AssignmentService(
        fromPartial<AssignmentRepository>({
          findProjectMember: jest.fn().mockResolvedValue({
            userId: 'user-owner',
            role: 'owner',
          }),
          bulkAssignWorkItems,
        }),
      );
      const assignRes = await assignmentService.bulkAssign(PROJ_ID, {
        workItemIds: [ID_B, ID_A, ID_B],
        assigneeId: 'user-owner',
      });
      expect(assignRes.workItemIds).toEqual([ID_A, ID_B]);

      // OCC conflict check
      let currentUpdatedAt = new Date('2026-10-14T12:00:00.000Z');
      const coreService = new CoreService(
        fromPartial<CoreRepository>({
          findWorkItemById: jest.fn(async () => ({
            id: ID_A,
            projectId: PROJ_ID,
            title: 'Original Title',
            updatedAt: currentUpdatedAt,
          })) as never,
          updateWorkItem: jest.fn(async (_id: string, data: Record<string, unknown>) => {
            currentUpdatedAt = new Date('2026-10-14T12:00:05.000Z');
            return { id: ID_A, projectId: PROJ_ID, ...data, updatedAt: currentUpdatedAt };
          }) as never,
          findLabelsByIds: jest.fn().mockResolvedValue([]),
        }),
        fromPartial<IdHandler>({}),
        new RankHandler(),
        fromPartial<CloneHandler>({}),
        fromPartial<EventHandler>({ dispatchUpdateEvents: jest.fn() }),
      );

      const snapshotTimestamp = '2026-10-14T12:00:00.000Z';
      const firstEdit = await coreService.updateWorkItem(
        ID_A,
        { title: 'User 1 Edit', expectedUpdatedAt: snapshotTimestamp },
        'user-1',
      );
      expect(firstEdit.workItem?.title).toBe('User 1 Edit');

      await expect(
        coreService.updateWorkItem(
          ID_A,
          { title: 'User 2 Stale Edit', expectedUpdatedAt: snapshotTimestamp },
          'user-2',
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('42-Item Research Dataset Benchmark (FLUX-1..FLUX-42)', () => {
    it('processes all 42 LaTeX-rich research items through getProjectWorkItems, getWorkItemAnalytics, getViolatedRelations, and HistoryService', async () => {
      const T0 = new Date('2026-10-04T09:00:00.000Z');
      const dayMs = 24 * 60 * 60 * 1000;
      const d = (daysDelta: number, hour = 9) => {
        const target = new Date(T0.getTime() + daysDelta * dayMs);
        target.setUTCHours(hour, 0, 0, 0);
        return target;
      };

      const stateDefs = {
        BACKLOG: { id: 'st-backlog', name: 'Backlog', group: 'backlog', sequence: 1000 },
        TODO: { id: 'st-todo', name: 'To Do', group: 'unstarted', sequence: 2000 },
        IN_PROGRESS: { id: 'st-in-progress', name: 'In Progress', group: 'started', sequence: 3000 },
        IN_REVIEW: { id: 'st-in-review', name: 'In Review', group: 'started', sequence: 4000 },
        DONE: { id: 'st-done', name: 'Done', group: 'completed', sequence: 5000 },
        CANCELLED: { id: 'st-cancelled', name: 'Cancelled', group: 'cancelled', sequence: 6000 },
      };

      const dataset = Array.from({ length: 42 }, (_, idx) => {
        const seq = idx + 1;
        let state = stateDefs.BACKLOG;
        let priority = 'medium';
        let timeSpent = 0;
        let completed = false;
        let startDate = d(16 + seq);
        let dueDate = d(30 + seq, 17);

        if (seq <= 8) {
          state = stateDefs.BACKLOG;
          priority = seq <= 3 ? 'high' : 'low';
        } else if (seq <= 18) {
          state = stateDefs.TODO;
          priority = seq <= 12 ? 'urgent' : 'medium';
          startDate = d(1);
          dueDate = d(7, 17);
        } else if (seq <= 29) {
          state = stateDefs.IN_PROGRESS;
          priority = 'high';
          timeSpent = 12.5;
          startDate = d(-6);
          dueDate = seq === 20 ? d(-3, 17) : d(5, 17);
          completed = seq === 20 || seq === 21 || seq === 24;
        } else if (seq <= 34) {
          state = stateDefs.IN_REVIEW;
          priority = 'urgent';
          timeSpent = 4.0;
          startDate = d(-2);
          dueDate = d(4, 17);
        } else if (seq <= 41) {
          state = stateDefs.DONE;
          priority = 'high';
          timeSpent = 20.0;
          completed = true;
          startDate = d(-20);
          dueDate = d(-5, 17);
        } else {
          state = stateDefs.CANCELLED;
          priority = 'none';
          timeSpent = 6.0;
          startDate = d(-22);
          dueDate = d(-18, 17);
        }

        return {
          id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
          identifier: `FLUX-${seq}`,
          sequenceNumber: seq,
          title: `Research Task FLUX-${seq}: Adaptive Moment Estimation ($\\beta_1, \\beta_2$)`,
          content: `## Objective\nProve $\\mathbb{E}[v_t] = \\mathbb{E}[g_t^2](1 - \\beta_2^t)$ for task FLUX-${seq}.`,
          projectId: 'proj-flux-research',
          authorId: 'user-lead',
          columnId: state.id,
          state,
          priority,
          rank: seq * 1000,
          timeSpent,
          completed,
          startDate,
          dueDate,
          labels: ['Deep Learning', 'Optimization'],
          relations:
            seq === 20
              ? [
                  {
                    id: 'rel-20-21',
                    targetWorkItemId: '00000000-0000-4000-8000-000000000021',
                    type: 'blocks',
                    createdAt: T0.toISOString(),
                  },
                ]
              : [],
          createdAt: T0,
          updatedAt: T0,
        };
      });

      const itemById = new Map(dataset.map((i) => [i.id, i]));
      const itemByIdentifier = new Map(dataset.map((i) => [i.identifier, i]));

      const coreService = new CoreService(
        fromPartial<CoreRepository>({
          findProjectWorkItems: jest.fn().mockResolvedValue(dataset),
          findLabelsByIds: jest.fn().mockResolvedValue([
            { id: 'lbl-dl', name: 'Deep Learning', color: '#3b82f6' },
            { id: 'lbl-opt', name: 'Optimization', color: '#10b981' },
          ]),
        }),
        fromPartial<IdHandler>({}),
        new RankHandler(),
        fromPartial<CloneHandler>({}),
        fromPartial<EventHandler>({ dispatchUpdateEvents: jest.fn() }),
      );

      const projectItems = await coreService.getProjectWorkItems('proj-flux-research');
      expect(projectItems).toHaveLength(42);
      expect(projectItems[0]?.content).toContain('\\mathbb{E}[v_t]');

      const analytics = await coreService.getWorkItemAnalytics('proj-flux-research');
      expect(analytics).toMatchObject({
        total: 42,
        byStateGroup: {
          backlog: 8,
          unstarted: 10,
          started: 16,
          completed: 7,
          cancelled: 1,
        },
      });
      expect(analytics.totalTimeSpent).toBeGreaterThan(250);

      const relationService = new RelationService(
        fromPartial<RelationRepository>({
          findWorkItem: jest.fn(async (id: string) =>
            itemById.get(id) ?? itemByIdentifier.get(id) ?? null,
          ) as never,
          findWorkItemsByIds: jest.fn(async (ids: string[]) =>
            ids.map((id) => itemById.get(id)).filter(Boolean),
          ) as never,
        }),
      );
      const { violations } = await relationService.getViolatedRelations('FLUX-20');
      expect(violations).toHaveLength(1);
      expect(violations[0].isViolated).toBe(true);

      const oldLatex = dataset[0].content;
      const newLatex =
        oldLatex + '\n- Added regret bound $\\mathcal{O}(\\sqrt{T})$ proof.';
      const diffSummary = summarizeDiff('content', oldLatex, newLatex);
      const historyService = new HistoryService(
        fromPartial<HistoryRepository>({
          findWorkItemActivityEvents: jest.fn().mockResolvedValue([
            {
              id: 'act-1',
              field: 'content',
              oldValue: oldLatex,
              newValue: newLatex,
              verb: 'updated',
              actor: { id: 'user-lead', name: 'Dr. Kingma' },
            },
          ]),
        }),
      );
      const activityRes = await historyService.getActivity('FLUX-1');
      expect(activityRes.activities[0].message).toBe(diffSummary);
    });
  });
});
