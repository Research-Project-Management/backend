import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { CoreService } from '@/modules/work-item/core/core.service';
import { RankHandler } from '@/modules/work-item/core/handlers/rank.handler';
import { BulkHandler } from '@/modules/work-item/core/handlers/bulk.handler';
import { RelationService } from '@/modules/work-item/relation/relation.service';
import { ArchiveService } from '@/modules/work-item/archive/archive.service';
import { AssignmentService } from '@/modules/work-item/assignment/assignment.service';
import { LabelService } from '@/modules/work-item/label/label.service';
import { HistoryService } from '@/modules/work-item/history/history.service';
import { summarizeDiff } from '@/modules/work-item/history/utils/diff.util';
import { validateHierarchyCycle } from '@/modules/work-item/core/utils/hierarchy.util';

describe('Work-Item Real-World Dataset & Edge-Case Experimentation Suite', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // BATCH 1: Hierarchy, DAG & CPM Scheduling Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Batch 1: Hierarchy, DAG & CPM Scheduling Edge Cases', () => {
    // ── 1. Multi-Edge & Transitive DAG Cycle Detection ────────────────────────
    describe('1.1 Multi-Edge & Transitive DAG Cycle Detection (RelationService)', () => {
      let relationService: RelationService;
      let mockRelationRepo: any;
      let mockPrisma: any;
      let itemStore: Map<string, any>;
      let edgeStore: Array<{
        sourceId: string;
        targetId: string;
        type: string;
      }>;

      beforeEach(() => {
        itemStore = new Map();
        edgeStore = [];

        for (let i = 1; i <= 6; i++) {
          const id = `00000000-0000-4000-8000-00000000000${i}`;
          itemStore.set(id, {
            id,
            identifier: `FLUX-${i}`,
            title: `Research Milestone ${i}`,
            projectId: 'proj-flux-1',
            relations: [],
          });
          itemStore.set(`FLUX-${i}`, itemStore.get(id));
        }

        mockPrisma = {
          $transaction: jest.fn().mockImplementation((cb) => cb(mockPrisma)),
          workItem: {
            findUnique: jest.fn().mockImplementation(({ where }) => {
              return Promise.resolve(itemStore.get(where.id) || null);
            }),
            update: jest.fn().mockImplementation(({ where, data }) => {
              const existing = itemStore.get(where.id);
              if (existing && data.relations) {
                existing.relations = data.relations;
              }
              return Promise.resolve(existing);
            }),
          },
          workItemRelation: {
            findMany: jest.fn().mockResolvedValue([]),
            upsert: jest.fn().mockImplementation(({ create }) => {
              edgeStore.push({
                sourceId: create.sourceId,
                targetId: create.targetId,
                type: create.type,
              });
              return Promise.resolve(create);
            }),
            deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        };

        mockRelationRepo = {
          prisma: mockPrisma,
          findWorkItem: jest
            .fn()
            .mockImplementation((idOrIdentifier: string) =>
              Promise.resolve(itemStore.get(idOrIdentifier) || null),
            ),
          findWorkItemsByIds: jest
            .fn()
            .mockImplementation((ids: string[]) =>
              Promise.resolve(
                ids.map((id) => itemStore.get(id)).filter(Boolean),
              ),
            ),
          findProjectGraphEdges: jest
            .fn()
            .mockImplementation(
              (_projectId: string, category: 'blocks' | 'duplicate_of') => {
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

                const result: Array<{ sourceId: string; targetId: string }> =
                  [];
                for (const e of edgeStore) {
                  if (forward.includes(e.type)) {
                    result.push({ sourceId: e.sourceId, targetId: e.targetId });
                  } else if (inverse.includes(e.type)) {
                    result.push({ sourceId: e.targetId, targetId: e.sourceId });
                  }
                }
                return Promise.resolve(result);
              },
            ),
        };

        relationService = new RelationService(mockRelationRepo);
      });

      it('should detect 5-hop deep transitive cycles (FLUX-1 -> FLUX-2 -> FLUX-3 -> FLUX-4 -> FLUX-5 -> FLUX-1)', async () => {
        // Build chain FLUX-1 -> FLUX-2 -> FLUX-3 -> FLUX-4 -> FLUX-5
        await relationService.addRelation('FLUX-1', {
          targetWorkItemId: 'FLUX-2',
          type: 'blocks',
        });
        await relationService.addRelation('FLUX-2', {
          targetWorkItemId: 'FLUX-3',
          type: 'blocks',
        });
        await relationService.addRelation('FLUX-3', {
          targetWorkItemId: 'FLUX-4',
          type: 'blocks',
        });
        await relationService.addRelation('FLUX-4', {
          targetWorkItemId: 'FLUX-5',
          type: 'blocks',
        });

        // Attempt FLUX-5 blocks FLUX-1
        await expect(
          relationService.addRelation('FLUX-5', {
            targetWorkItemId: 'FLUX-1',
            type: 'blocks',
          }),
        ).rejects.toThrow(BadRequestException);

        // Attempt FLUX-1 blocked_by FLUX-5 (inverse equivalent of FLUX-5 blocks FLUX-1)
        await expect(
          relationService.addRelation('FLUX-1', {
            targetWorkItemId: 'FLUX-5',
            type: 'blocked_by',
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it('should detect transitive cycles across mixed PMI CPM relation types (FS, SS, FF, SF) and duplicate_of chains', async () => {
        await relationService.addRelation('FLUX-1', {
          targetWorkItemId: 'FLUX-2',
          type: 'FINISH_TO_START',
        });
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

        // Attempting to close the loop from FLUX-5 to FLUX-1 via FINISH_TO_START must fail
        await expect(
          relationService.addRelation('FLUX-5', {
            targetWorkItemId: 'FLUX-1',
            type: 'FINISH_TO_START',
          }),
        ).rejects.toThrow('Circular dependency detected');

        // Separate duplicate_of transitive chain: FLUX-1 -> FLUX-2 -> FLUX-3
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
      });

      it('should reject self-loops, duplicate relations (ConflictException), and cross-project links (BadRequestException)', async () => {
        // 1. Self-loop rejection
        await expect(
          relationService.addRelation('FLUX-1', {
            targetWorkItemId: 'FLUX-1',
            type: 'blocks',
          }),
        ).rejects.toThrow(BadRequestException);

        // 2. Duplicate relation rejection (ConflictException)
        await relationService.addRelation('FLUX-1', {
          targetWorkItemId: 'FLUX-2',
          type: 'blocks',
        });
        await expect(
          relationService.addRelation('FLUX-1', {
            targetWorkItemId: 'FLUX-2',
            type: 'blocks',
          }),
        ).rejects.toThrow(ConflictException);

        // 3. Cross-project isolation
        const externalItem = {
          id: '00000000-0000-4000-8000-999999999999',
          identifier: 'EXT-1',
          title: 'External Project Issue',
          projectId: 'proj-external-99',
          relations: [],
        };
        itemStore.set(externalItem.id, externalItem);
        itemStore.set('EXT-1', externalItem);

        await expect(
          relationService.addRelation('FLUX-1', {
            targetWorkItemId: 'EXT-1',
            type: 'relates_to',
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it('should accurately detect Temporal & CPM violations (FS, SS, FF, SF, Leap Year 2028-02-29, and Midnight ISO boundaries)', async () => {
        const predecessor = {
          id: 'pred-1',
          title: 'Predecessor Task',
          projectId: 'proj-flux-1',
          startDate: new Date('2028-02-29T00:00:00.000Z'), // Leap year day
          dueDate: new Date('2026-10-15T00:00:00.000Z'), // 1ms after Oct 14 midnight boundary
          relations: [
            {
              id: 'rel-fs-violated',
              targetWorkItemId: 'succ-fs',
              type: 'FINISH_TO_START',
              createdAt: new Date().toISOString(),
            },
            {
              id: 'rel-ss-violated',
              targetWorkItemId: 'succ-ss',
              type: 'START_TO_START',
              createdAt: new Date().toISOString(),
            },
            {
              id: 'rel-ff-violated',
              targetWorkItemId: 'succ-ff',
              type: 'FINISH_TO_FINISH',
              createdAt: new Date().toISOString(),
            },
            {
              id: 'rel-sf-violated',
              targetWorkItemId: 'succ-sf',
              type: 'START_TO_FINISH',
              createdAt: new Date().toISOString(),
            },
            {
              id: 'rel-fs-valid-boundary',
              targetWorkItemId: 'succ-valid',
              type: 'blocks',
              createdAt: new Date().toISOString(),
            },
          ],
        };

        const targets: Record<string, any> = {
          // FS violation: predecessor dueDate (2026-10-15T00:00:00.000Z) > successor startDate (2026-10-14T23:59:59.999Z)
          'succ-fs': {
            id: 'succ-fs',
            title: 'Successor FS',
            startDate: new Date('2026-10-14T23:59:59.999Z'),
            dueDate: new Date('2026-10-20T00:00:00.000Z'),
          },
          // SS violation: predecessor startDate (2028-02-29) > successor startDate (2028-02-28)
          'succ-ss': {
            id: 'succ-ss',
            title: 'Successor SS (Leap Year)',
            startDate: new Date('2028-02-28T23:59:59.999Z'),
            dueDate: new Date('2028-03-05T00:00:00.000Z'),
          },
          // FF violation: predecessor dueDate (2026-10-15T00:00:00.000Z) > successor dueDate (2026-10-14T23:59:59.999Z)
          'succ-ff': {
            id: 'succ-ff',
            title: 'Successor FF',
            startDate: new Date('2026-10-10T00:00:00.000Z'),
            dueDate: new Date('2026-10-14T23:59:59.999Z'),
          },
          // SF violation: predecessor startDate (2028-02-29T00:00:00.000Z) > successor dueDate (2028-02-28T23:59:59.999Z)
          'succ-sf': {
            id: 'succ-sf',
            title: 'Successor SF',
            startDate: new Date('2028-02-20T00:00:00.000Z'),
            dueDate: new Date('2028-02-28T23:59:59.999Z'),
          },
          // Exact boundary non-violation: predecessor dueDate === successor startDate
          'succ-valid': {
            id: 'succ-valid',
            title: 'Successor Valid Exact Hand-off',
            startDate: new Date('2026-10-15T00:00:00.000Z'),
            dueDate: new Date('2026-10-20T00:00:00.000Z'),
          },
        };

        itemStore.set('pred-1', predecessor);
        for (const [k, v] of Object.entries(targets)) {
          itemStore.set(k, v);
        }

        const { violations } =
          await relationService.getViolatedRelations('pred-1');

        expect(violations).toHaveLength(5);
        const byId = new Map(violations.map((v) => [v.relationId, v]));

        expect(byId.get('rel-fs-violated')?.isViolated).toBe(true);
        expect(byId.get('rel-ss-violated')?.isViolated).toBe(true);
        expect(byId.get('rel-ff-violated')?.isViolated).toBe(true);
        expect(byId.get('rel-sf-violated')?.isViolated).toBe(true);
        expect(byId.get('rel-fs-valid-boundary')?.isViolated).toBe(false);
      });
    });

    // ── 2. Sub-Issue Hierarchy & Cascading Rules ──────────────────────────────
    describe('1.2 Sub-Issue Hierarchy & Cascading Rules (CoreService, HierarchyUtil, LabelService)', () => {
      let coreService: CoreService;
      let mockCoreRepo: any;
      let itemMap: Map<string, any>;

      const UUID_1 = '11111111-1111-4111-8111-111111111111';
      const UUID_2 = '22222222-2222-4222-8222-222222222222';
      const UUID_3 = '33333333-3333-4333-8333-333333333333';

      beforeEach(() => {
        itemMap = new Map([
          [
            UUID_1,
            {
              id: UUID_1,
              identifier: 'FLUX-1',
              title: 'Root Epic',
              projectId: 'proj-1',
              parentWorkItemId: null,
            },
          ],
          [
            UUID_2,
            {
              id: UUID_2,
              identifier: 'FLUX-2',
              title: 'Child Task',
              projectId: 'proj-1',
              parentWorkItemId: UUID_1,
            },
          ],
          [
            UUID_3,
            {
              id: UUID_3,
              identifier: 'FLUX-3',
              title: 'Grandchild Subtask',
              projectId: 'proj-1',
              parentWorkItemId: UUID_2,
            },
          ],
        ]);

        mockCoreRepo = {
          findWorkItemById: jest
            .fn()
            .mockImplementation((id: string) =>
              Promise.resolve(itemMap.get(id) || null),
            ),
          updateWorkItem: jest
            .fn()
            .mockImplementation((id: string, data: any) =>
              Promise.resolve({ ...itemMap.get(id), ...data }),
            ),
          disconnectParentWorkItem: jest.fn().mockImplementation((id: string) =>
            Promise.resolve({
              ...itemMap.get(id),
              parentWorkItemId: null,
              parentWorkItem: null,
            }),
          ),
          findLabelsByIds: jest.fn().mockResolvedValue([]),
        };

        coreService = new CoreService(
          mockCoreRepo,
          {} as any,
          new RankHandler(),
          {} as any,
          { dispatchUpdateEvents: jest.fn() } as any,
        );
      });

      it('should reject self-parenting (parentWorkItemId === workItemId) and circular descendant parenting in CoreService.updateWorkItem', async () => {
        // 1. Self-parenting check
        await expect(
          coreService.updateWorkItem(UUID_1, {
            parentWorkItemId: UUID_1,
          }),
        ).rejects.toThrow(BadRequestException);

        // 2. Setting parent of Root (UUID_1) to its own Grandchild (UUID_3) -> cycle UUID_1 -> UUID_3 -> UUID_2 -> UUID_1
        await expect(
          coreService.updateWorkItem(UUID_1, {
            parentWorkItemId: UUID_3,
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it('should enforce maximum hierarchy depth constraint in validateHierarchyCycle', async () => {
        const deepItems = new Map<string, any>();
        for (let i = 1; i <= 12; i++) {
          const id = `node-${i}`;
          deepItems.set(id, {
            id,
            projectId: 'proj-1',
            parentWorkItemId: i > 1 ? `node-${i - 1}` : null,
          });
        }

        await expect(
          validateHierarchyCycle(
            'node-new',
            deepItems.get('node-12'),
            async (id) => deepItems.get(id) || null,
            10,
          ),
        ).rejects.toThrow('Hierarchy depth cannot exceed 10 levels');
      });

      it('should convert sub-item to root (convertSubItemToRoot) and clear parentWorkItemId', async () => {
        const result = await coreService.convertSubItemToRoot(UUID_2);
        expect(mockCoreRepo.disconnectParentWorkItem).toHaveBeenCalledWith(
          UUID_2,
        );
        expect(result.workItem?.parentWorkItemId).toBeNull();
      });

      it('should enforce 1-level label hierarchy in LabelService (no self-parent, no nesting under sub-label, no nesting parent with children)', async () => {
        const mockLabelRepo: any = {
          findProject: jest.fn().mockResolvedValue({ id: 'proj-1' }),
          findByNameInProject: jest.fn().mockResolvedValue(null),
          findById: jest.fn().mockImplementation((id: string) => {
            if (id === 'lbl-root-with-kids') {
              return Promise.resolve({
                id: 'lbl-root-with-kids',
                name: 'Root With Kids',
                projectId: 'proj-1',
                parentId: null,
                children: [{ id: 'lbl-child-1', name: 'Child 1' }],
              });
            }
            if (id === 'lbl-child-1') {
              return Promise.resolve({
                id: 'lbl-child-1',
                name: 'Child 1',
                projectId: 'proj-1',
                parentId: 'lbl-root-with-kids',
                children: [],
              });
            }
            if (id === 'lbl-root-empty') {
              return Promise.resolve({
                id: 'lbl-root-empty',
                name: 'Root Empty',
                projectId: 'proj-1',
                parentId: null,
                children: [],
              });
            }
            return Promise.resolve(null);
          }),
        };

        const labelService = new LabelService(mockLabelRepo);

        // 1. Self-parent rejection
        await expect(
          labelService.updateProjectLabel('proj-1', 'lbl-root-empty', {
            parentId: 'lbl-root-empty',
          }),
        ).rejects.toThrow('A label cannot be its own parent');

        // 2. Cannot nest under a child label (depth > 1)
        await expect(
          labelService.createProjectLabel('proj-1', 'user-1', {
            name: 'Grandchild Label',
            parentId: 'lbl-child-1',
          }),
        ).rejects.toThrow(BadRequestException);

        // 3. Cannot turn a label that already has sub-labels into a child label
        await expect(
          labelService.updateProjectLabel('proj-1', 'lbl-root-with-kids', {
            parentId: 'lbl-root-empty',
          }),
        ).rejects.toThrow(BadRequestException);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // BATCH 2: Rank Collisions, Concurrent Bulk Updates, OCC & 42-Item Benchmark
  // ═══════════════════════════════════════════════════════════════════════════
  describe('Batch 2: LexoRank Collisions, Bulk Canonical Deduplication, OCC & 42-Item Research Benchmark', () => {
    // ── 1. Rank Collisions & Precision Exhaustion ─────────────────────────────
    describe('2.1 Rank Collisions & Precision Exhaustion (RankHandler)', () => {
      let rankHandler: RankHandler;

      beforeEach(() => {
        rankHandler = new RankHandler();
      });

      it('should detect precision exhaustion (< 0.0001) during 50 sequential insertions between 1000 and 1001 and trigger rebalanceColumnRanks', () => {
        const columnItems: Array<{
          id: string;
          columnId: string;
          rank: number;
        }> = [
          { id: 'anchor-low', columnId: 'todo', rank: 1000 },
          { id: 'anchor-high', columnId: 'todo', rank: 1001 },
        ];

        let low = 1000;
        const high = 1001;
        let rebalanceTriggeredCount = 0;

        for (let step = 1; step <= 50; step++) {
          const newItemId = `inserted-${step}`;
          const movingItem = { id: newItemId, columnId: 'todo', rank: 0 };

          const res = rankHandler.calculateFractionalReorder(
            columnItems,
            newItemId,
            'todo',
            low,
            high,
            () => false,
            movingItem,
          );

          if (res.rebalanced) {
            rebalanceTriggeredCount += 1;
            // Apply rebalanced ranks to columnItems
            columnItems.length = 0;
            for (const u of res.updates) {
              columnItems.push({
                id: u.id,
                columnId: u.columnId,
                rank: u.rank,
              });
            }
            // After rebalancing, ranks are uniformly spaced by 1000 (1000, 2000, 3000...)
            expect(columnItems[0].rank).toBe(1000);
            expect(columnItems[1].rank).toBe(2000);
            low = columnItems[0].rank;
          } else {
            columnItems.push({
              id: newItemId,
              columnId: 'todo',
              rank: res.rank,
            });
            low = res.rank;
          }
        }

        // Between 1000 and 1001 (gap = 1), binary halving crosses < 0.0001 at step 14 (2^-14 = 0.000061035)
        expect(rebalanceTriggeredCount).toBeGreaterThanOrEqual(1);

        // Verify all final ranks are strictly monotonic and collision-free
        const sortedRanks = [...columnItems]
          .sort((a, b) => a.rank - b.rank)
          .map((i) => i.rank);
        const uniqueRanks = new Set(sortedRanks);
        expect(uniqueRanks.size).toBe(columnItems.length);
      });

      it('should cleanly handle reordering to top of column (prevRank = null), bottom of column (nextRank = null), and empty column', () => {
        // Empty column
        const emptyRes = rankHandler.computeMidpointRank(null, null);
        expect(emptyRes).toEqual({ rank: 1000, needsRebalance: false });

        // Top of column (prevRank = null, nextRank = 1000)
        const topRes = rankHandler.computeMidpointRank(null, 1000);
        expect(topRes.rank).toBe(500);
        expect(topRes.needsRebalance).toBe(false);

        // Bottom of column (prevRank = 3000, nextRank = null)
        const bottomRes = rankHandler.computeMidpointRank(3000, null);
        expect(bottomRes.rank).toBe(4000);
        expect(bottomRes.needsRebalance).toBe(false);
      });
    });

    // ── 2. Concurrent Bulk Updates, Canonical Ordering & OCC ──────────────────
    describe('2.2 Concurrent Bulk Updates, Canonical Ordering & OCC (BulkHandler, ArchiveService, AssignmentService)', () => {
      const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const PROJ_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

      it('should deduplicate and canonically sort duplicate workItemIds in BulkHandler, ArchiveService, and AssignmentService', async () => {
        // 1. BulkHandler deduplication
        const mockCoreRepo: any = {
          findProjectWithColumns: jest.fn().mockResolvedValue({
            id: PROJ_ID,
            states: [{ id: 'done', name: 'Done', group: 'completed' }],
          }),
          bulkUpdateWorkItems: jest.fn().mockResolvedValue({ count: 2 }),
          bulkDeleteWorkItems: jest.fn().mockResolvedValue({ count: 2 }),
        };
        const mockDispatcher: any = {
          emitBulkUpdated: jest.fn(),
          emitBulkDeleted: jest.fn(),
        };
        const bulkHandler = new BulkHandler(mockCoreRepo, mockDispatcher);

        await bulkHandler.bulkUpdate(
          PROJ_ID,
          {
            workItemIds: [ID_B, ID_A, ID_B, ID_A],
            data: { columnId: 'done' },
          },
          'user-1',
        );

        expect(mockCoreRepo.bulkUpdateWorkItems).toHaveBeenCalledWith(
          PROJ_ID,
          [ID_A, ID_B],
          expect.objectContaining({ columnId: 'done', completed: true }),
        );

        // 2. ArchiveService deduplication
        const mockArchiveRepo: any = {
          findWorkItemsByIds: jest.fn().mockResolvedValue([
            { id: ID_A, projectId: PROJ_ID },
            { id: ID_B, projectId: PROJ_ID },
          ]),
          bulkArchive: jest.fn().mockResolvedValue({ count: 2 }),
        };
        const archiveService = new ArchiveService(mockArchiveRepo);
        await archiveService.bulkArchiveWorkItems(
          { workItemIds: [ID_B, ID_A, ID_B] },
          'user-1',
        );
        expect(mockArchiveRepo.bulkArchive).toHaveBeenCalledWith([ID_A, ID_B]);

        // 3. AssignmentService deduplication
        const mockAssignRepo: any = {
          findProjectMember: jest.fn().mockResolvedValue({
            userId: 'user-owner',
            role: 'owner',
          }),
          bulkAssignWorkItems: jest.fn().mockResolvedValue(2),
        };
        const assignmentService = new AssignmentService(mockAssignRepo);
        const assignRes = await assignmentService.bulkAssign(PROJ_ID, {
          workItemIds: [ID_B, ID_A, ID_B],
          assigneeId: 'user-owner',
        });
        expect(mockAssignRepo.bulkAssignWorkItems).toHaveBeenCalledWith(
          PROJ_ID,
          [ID_A, ID_B],
          'user-owner',
        );
        expect(assignRes.workItemIds).toEqual([ID_A, ID_B]);
      });

      it('should enforce Optimistic Concurrency Control (expectedUpdatedAt) when two users edit the same work item concurrently', async () => {
        let currentUpdatedAt = new Date('2026-10-14T12:00:00.000Z');
        const mockRepo: any = {
          findWorkItemById: jest.fn().mockImplementation(() =>
            Promise.resolve({
              id: ID_A,
              projectId: PROJ_ID,
              title: 'Original Title',
              updatedAt: currentUpdatedAt,
            }),
          ),
          updateWorkItem: jest.fn().mockImplementation((_id, data) => {
            currentUpdatedAt = new Date('2026-10-14T12:00:05.000Z');
            return Promise.resolve({
              id: ID_A,
              projectId: PROJ_ID,
              ...data,
              updatedAt: currentUpdatedAt,
            });
          }),
          findLabelsByIds: jest.fn().mockResolvedValue([]),
        };

        const coreService = new CoreService(
          mockRepo,
          {} as any,
          new RankHandler(),
          {} as any,
          { dispatchUpdateEvents: jest.fn() } as any,
        );

        // User 1 and User 2 both read the work item at 12:00:00.000Z
        const snapshotTimestamp = '2026-10-14T12:00:00.000Z';

        // User 1 saves first -> succeeds and advances updatedAt to 12:00:05.000Z
        const res1 = await coreService.updateWorkItem(
          ID_A,
          {
            title: 'User 1 Edit',
            expectedUpdatedAt: snapshotTimestamp,
          },
          'user-1',
        );
        expect(res1.workItem?.title).toBe('User 1 Edit');

        // User 2 attempts to save with stale expectedUpdatedAt (12:00:00.000Z vs 12:00:05.000Z) -> throws ConflictException
        await expect(
          coreService.updateWorkItem(
            ID_A,
            {
              title: 'User 2 Conflicting Edit',
              expectedUpdatedAt: snapshotTimestamp,
            },
            'user-2',
          ),
        ).rejects.toThrow(ConflictException);
      });
    });

    // ── 3. Realistic 42-Item Research Project Dataset Benchmark ───────────────
    describe('2.3 Realistic 42-Item Research Project Dataset Benchmark (FLUX-1..FLUX-42)', () => {
      const T0 = new Date('2026-10-04T09:00:00.000Z');
      const dayMs = 24 * 60 * 60 * 1000;
      const d = (daysDelta: number, hour = 9) => {
        const target = new Date(T0.getTime() + daysDelta * dayMs);
        target.setUTCHours(hour, 0, 0, 0);
        return target;
      };

      const buildResearchDataset42 = () => {
        const stateDefs = {
          BACKLOG: {
            id: 'st-backlog',
            name: 'Backlog',
            group: 'backlog',
            sequence: 1000,
          },
          TODO: {
            id: 'st-todo',
            name: 'To Do',
            group: 'unstarted',
            sequence: 2000,
          },
          IN_PROGRESS: {
            id: 'st-in-progress',
            name: 'In Progress',
            group: 'started',
            sequence: 3000,
          },
          IN_REVIEW: {
            id: 'st-in-review',
            name: 'In Review',
            group: 'started',
            sequence: 4000,
          },
          DONE: {
            id: 'st-done',
            name: 'Done',
            group: 'completed',
            sequence: 5000,
          },
          CANCELLED: {
            id: 'st-cancelled',
            name: 'Cancelled',
            group: 'cancelled',
            sequence: 6000,
          },
        };

        const items: any[] = [];
        for (let seq = 1; seq <= 42; seq++) {
          let state = stateDefs.BACKLOG;
          let priority = 'medium';
          let timeSpent = 0;
          let completed = false;
          let startDate = d(16 + seq);
          let dueDate = d(30 + seq, 17);

          if (seq >= 1 && seq <= 8) {
            state = stateDefs.BACKLOG;
            priority = seq <= 3 ? 'high' : 'low';
          } else if (seq >= 9 && seq <= 18) {
            state = stateDefs.TODO;
            priority = seq <= 12 ? 'urgent' : 'medium';
            startDate = d(1);
            dueDate = d(7, 17);
          } else if (seq >= 19 && seq <= 29) {
            state = stateDefs.IN_PROGRESS;
            priority = 'high';
            timeSpent = 12.5;
            startDate = d(-6);
            dueDate = seq === 20 ? d(-3, 17) : d(5, 17);
            completed = seq === 20 || seq === 21 || seq === 24;
          } else if (seq >= 30 && seq <= 34) {
            state = stateDefs.IN_REVIEW;
            priority = 'urgent';
            timeSpent = 4.0;
            startDate = d(-2);
            dueDate = d(4, 17);
          } else if (seq >= 35 && seq <= 41) {
            state = stateDefs.DONE;
            priority = 'high';
            timeSpent = 20.0;
            completed = true;
            startDate = d(-20);
            dueDate = d(-5, 17);
          } else if (seq === 42) {
            state = stateDefs.CANCELLED;
            priority = 'none';
            timeSpent = 6.0;
            completed = false;
            startDate = d(-22);
            dueDate = d(-18, 17);
          }

          items.push({
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
          });
        }
        return items;
      };

      it('should process all 42 research items through CoreService.getProjectWorkItems, getWorkItemAnalytics, RelationService.getViolatedRelations, and HistoryService.summarizeDiff', async () => {
        const dataset = buildResearchDataset42();
        const itemById = new Map(dataset.map((i) => [i.id, i]));
        const itemByIdentifier = new Map(dataset.map((i) => [i.identifier, i]));

        const mockCoreRepo: any = {
          findProjectWorkItems: jest.fn().mockResolvedValue(dataset),
          findLabelsByIds: jest.fn().mockResolvedValue([
            { id: 'lbl-dl', name: 'Deep Learning', color: '#3b82f6' },
            { id: 'lbl-opt', name: 'Optimization', color: '#10b981' },
          ]),
        };

        const coreService = new CoreService(
          mockCoreRepo,
          {} as any,
          new RankHandler(),
          {} as any,
          { dispatchUpdateEvents: jest.fn() } as any,
        );

        // 1. CoreService.getProjectWorkItems
        const projectItems =
          await coreService.getProjectWorkItems('proj-flux-research');
        expect(projectItems).toHaveLength(42);
        expect(projectItems[0]?.identifier).toBe('FLUX-1');
        expect(projectItems[0]?.content).toContain('\\mathbb{E}[v_t]');

        // 2. CoreService.getWorkItemAnalytics
        const analytics =
          await coreService.getWorkItemAnalytics('proj-flux-research');
        expect(analytics.total).toBe(42);
        expect(analytics.byStateGroup.backlog).toBe(8);
        expect(analytics.byStateGroup.unstarted).toBe(10);
        expect(analytics.byStateGroup.started).toBe(16); // 11 IN_PROGRESS + 5 IN_REVIEW
        expect(analytics.byStateGroup.completed).toBe(7); // FLUX-35..41
        expect(analytics.byStateGroup.cancelled).toBe(1); // FLUX-42
        expect(analytics.totalTimeSpent).toBeGreaterThan(250);

        // 3. RelationService.getViolatedRelations on FLUX-20 -> FLUX-21
        // FLUX-20 dueDate is d(-3, 17), FLUX-21 startDate is d(-6) -> overlap violation!
        const mockRelationRepo: any = {
          findWorkItem: jest
            .fn()
            .mockImplementation((id: string) =>
              Promise.resolve(
                itemById.get(id) || itemByIdentifier.get(id) || null,
              ),
            ),
          findWorkItemsByIds: jest
            .fn()
            .mockImplementation((ids: string[]) =>
              Promise.resolve(
                ids.map((id) => itemById.get(id)).filter(Boolean),
              ),
            ),
        };
        const relationService = new RelationService(mockRelationRepo);
        const { violations } =
          await relationService.getViolatedRelations('FLUX-20');
        expect(violations).toHaveLength(1);
        expect(violations[0].isViolated).toBe(true);
        expect(violations[0].targetWorkItemId).toBe(
          '00000000-0000-4000-8000-000000000021',
        );

        // 4. HistoryService & summarizeDiff on LaTeX-rich research descriptions
        const oldLatex = dataset[0].content;
        const newLatex =
          oldLatex +
          '\n- Added regret bound $\\mathcal{O}(\\sqrt{T})$ proof in Appendix A.';
        const diffSummary = summarizeDiff('content', oldLatex, newLatex);
        expect(diffSummary).toBe(
          `Updated description (+${newLatex.length - oldLatex.length} chars)`,
        );

        const mockHistoryRepo: any = {
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
        };
        const historyService = new HistoryService(mockHistoryRepo);
        const activityRes = await historyService.getActivity('FLUX-1');
        expect(activityRes.total).toBe(1);
        expect(activityRes.activities[0].message).toBe(diffSummary);
      });
    });
  });
});
