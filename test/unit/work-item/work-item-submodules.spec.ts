import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EntityType } from '@prisma/client';
import { fromPartial } from '@total-typescript/shoehorn';
import type { PrismaService, RedisCacheService } from '@/core';
import { DomainActivityEvent } from '@/modules/project/activity/events/activity.events';
import { ArchiveRepository } from '@/modules/project/work-item/archive/archive.repository';
import { ArchiveService } from '@/modules/project/work-item/archive/archive.service';
import { AssignmentRepository } from '@/modules/project/work-item/assignment/assignment.repository';
import { AssignmentService } from '@/modules/project/work-item/assignment/assignment.service';
import { AttachmentService } from '@/modules/project/work-item/attachment/attachment.service';
import { CommentRepository } from '@/modules/project/work-item/comment/comment.repository';
import { CommentService } from '@/modules/project/work-item/comment/comment.service';
import { CoreRepository } from '@/modules/project/work-item/core/core.repository';
import { CoreService } from '@/modules/project/work-item/core/core.service';
import { DraftRepository } from '@/modules/project/work-item/draft/draft.repository';
import { DraftService } from '@/modules/project/work-item/draft/draft.service';
import { HistoryRepository } from '@/modules/project/work-item/history/history.repository';
import {
  HistoryService,
  summarizeDiff,
} from '@/modules/project/work-item/history/history.service';
import { LabelRepository } from '@/modules/project/work-item/label/label.repository';
import { LabelService } from '@/modules/project/work-item/label/label.service';
import { RelationService } from '@/modules/project/work-item/relation/relation.service';
import { StateRepository } from '@/modules/project/work-item/state/state.repository';
import { StateService } from '@/modules/project/work-item/state/state.service';
import { WorkItemFacade } from '@/modules/project/work-item/work-item.facade';

describe('Work-Item Submodules, Repository Type Safety & Facade Suite', () => {
  describe('CoreRepository (State Relation Mapping & Hybrid UUID/Name Label Lookup)', () => {
    it('maps columnId to state.connect when relation connects are present, preserves stateId for scalar creates, and splits UUID vs name label queries', async () => {
      const workItemCreate = jest.fn(async (args: { data: unknown }) => args.data);
      const workItemUpdate = jest.fn(async (args: { data: unknown }) => args.data);
      const spaceLabelFindMany = jest.fn().mockResolvedValue([]);

      const repository = new CoreRepository(
        fromPartial<PrismaService>({
          workItem: { create: workItemCreate, update: workItemUpdate },
          spaceLabel: { findMany: spaceLabelFindMany },
        }),
      );

      await repository.createWorkItem({
        title: 'Task 1',
        content: '',
        columnId: '326b4b76-cc73-4788-894d-aea0e0301507',
        project: { connect: { id: '4e61078c-0073-4d42-9970-75e5e106286a' } },
        author: { connect: { id: '3f3fb23b-2193-4763-84e5-c934a10b3cd9' } },
      } as never);

      const relCreateData = workItemCreate.mock.calls[0]?.[0]?.data as Record<
        string,
        unknown
      >;
      expect(relCreateData.columnId).toBeUndefined();
      expect(relCreateData.state).toEqual({
        connect: { id: '326b4b76-cc73-4788-894d-aea0e0301507' },
      });

      await repository.createWorkItem({
        title: 'Cloned Task',
        content: '',
        columnId: '326b4b76-cc73-4788-894d-aea0e0301507',
        projectId: '4e61078c-0073-4d42-9970-75e5e106286a',
        authorId: '3f3fb23b-2193-4763-84e5-c934a10b3cd9',
      } as never);

      const scalarCreateData = workItemCreate.mock.calls[1]?.[0]?.data as Record<
        string,
        unknown
      >;
      expect(scalarCreateData.stateId).toBe(
        '326b4b76-cc73-4788-894d-aea0e0301507',
      );
      expect(scalarCreateData.state).toBeUndefined();

      await repository.updateWorkItem('item-123', {
        columnId: 'be2e87e3-0b7b-4009-adab-e4470c9554a9',
        assignee: { connect: { id: 'user-123' } },
      } as never);
      const updateData = workItemUpdate.mock.calls[0]?.[0]?.data as Record<
        string,
        unknown
      >;
      expect(updateData.columnId).toBeUndefined();
      expect(updateData.state).toEqual({
        connect: { id: 'be2e87e3-0b7b-4009-adab-e4470c9554a9' },
      });

      const projectId = '01a1078c-3162-723a-b454-814b8af5f5ec';
      const validUuid = '88e686b9-1226-4b65-abbf-5cd319ba61b2';

      await expect(repository.findLabelsByIds(projectId, [])).resolves.toEqual([]);
      expect(spaceLabelFindMany).not.toHaveBeenCalled();

      await repository.findLabelsByIds(projectId, ['Deep Learning']);
      expect(spaceLabelFindMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {
            AND: [{ spaceId: projectId }, { name: { in: ['Deep Learning'] } }],
          },
        }),
      );

      await repository.findLabelsByIds(projectId, [validUuid]);
      expect(spaceLabelFindMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {
            AND: [{ spaceId: projectId }, { id: { in: [validUuid] } }],
          },
        }),
      );

      await repository.findLabelsByIds(projectId, [validUuid, 'GPU Cluster']);
      expect(spaceLabelFindMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              { spaceId: projectId },
              {
                OR: [
                  { id: { in: [validUuid] } },
                  { name: { in: ['GPU Cluster'] } },
                ],
              },
            ],
          },
        }),
      );
    });
  });

  describe('ArchiveService', () => {
    it('archives, rejects double-archive, restores, bulk-archives, and lists archived work items', async () => {
      const mockRepo = fromPartial<jest.Mocked<ArchiveRepository>>({
        findWorkItemWithProject: jest.fn(),
        archiveWorkItem: jest.fn(),
        restoreWorkItem: jest.fn(),
        findWorkItemsByIds: jest.fn(),
        bulkArchive: jest.fn(),
        findArchivedWorkItems: jest.fn(),
      });
      const emit = jest.fn();
      const service = new ArchiveService(
        mockRepo,
        fromPartial<EventEmitter2>({ emit }),
        fromPartial<RedisCacheService>({ del: jest.fn().mockResolvedValue(1) }),
      );

      const active = {
        id: 'wi-1',
        identifier: 'FLUX-1',
        projectId: 'proj-1',
        archivedAt: null,
      };
      const archived = { ...active, archivedAt: new Date() };

      mockRepo.findWorkItemWithProject.mockResolvedValueOnce(fromPartial(active));
      mockRepo.archiveWorkItem.mockResolvedValueOnce(fromPartial(archived));
      const res = await service.archiveWorkItem('wi-1', 'user-1');
      expect(res.success).toBe(true);
      expect(emit).toHaveBeenCalledWith(
        'work-item.archived',
        expect.objectContaining({
          entityType: EntityType.work_item,
          entityId: 'wi-1',
          verb: 'archived',
        }),
      );

      mockRepo.findWorkItemWithProject.mockResolvedValueOnce(fromPartial(archived));
      await expect(service.archiveWorkItem('wi-1', 'user-1')).rejects.toThrow(
        BadRequestException,
      );

      mockRepo.findWorkItemWithProject.mockResolvedValueOnce(fromPartial(archived));
      mockRepo.restoreWorkItem.mockResolvedValueOnce(fromPartial(active));
      await expect(
        service.restoreWorkItem('wi-1', 'user-1'),
      ).resolves.toMatchObject({ success: true });

      mockRepo.findWorkItemsByIds.mockResolvedValueOnce([
        fromPartial({ id: 'wi-1', projectId: 'proj-1' }),
        fromPartial({ id: 'wi-2', projectId: 'proj-1' }),
      ]);
      mockRepo.bulkArchive.mockResolvedValueOnce({ count: 2 });
      const bulkRes = await service.bulkArchive(
        { workItemIds: ['wi-1', 'wi-2'], reason: 'Sprint cleanup' },
        'user-1',
      );
      expect(bulkRes.count).toBe(2);
      expect(emit).toHaveBeenCalledWith(
        'activity.event',
        expect.any(DomainActivityEvent),
      );

      mockRepo.findArchivedWorkItems.mockResolvedValueOnce(
        fromPartial({ workItems: [{ id: 'wi-arch-1' }], total: 1, page: 1, limit: 50 }),
      );
      const listRes = await service.getArchivedWorkItems('proj-1', { page: 1 });
      expect(listRes.archivedItems).toHaveLength(1);
      expect(listRes.count).toBe(1);
    });
  });

  describe('AssignmentService', () => {
    it('assigns eligible members, blocks reviewers, handles join/leave, primary failover, and subscriptions', async () => {
      const mockRepo = fromPartial<jest.Mocked<AssignmentRepository>>({
        findWorkItemWithProject: jest.fn(),
        findProjectMember: jest.fn(),
        findProjectMembers: jest.fn(),
        assignWorkItem: jest.fn(),
        setAssigneeIds: jest.fn(),
        setSubscriberIds: jest.fn(),
      });
      const emit = jest.fn();
      const service = new AssignmentService(
        mockRepo,
        fromPartial<EventEmitter2>({ emit }),
        fromPartial<RedisCacheService>({ del: jest.fn().mockResolvedValue(1) }),
      );

      mockRepo.findWorkItemWithProject.mockResolvedValue(
        fromPartial({ id: 'wi-1', identifier: 'FLUX-1', projectId: 'proj-1', assigneeId: null }),
      );
      mockRepo.findProjectMember.mockResolvedValueOnce(
        fromPartial({ userId: 'user-2', role: 'contributor' }),
      );
      mockRepo.assignWorkItem.mockResolvedValueOnce(
        fromPartial({ id: 'wi-1', projectId: 'proj-1', assigneeId: 'user-2' }),
      );
      await expect(
        service.assignWorkItem('proj-1', 'wi-1', 'user-2', 'actor-1'),
      ).resolves.toMatchObject({ newAssigneeId: 'user-2' });

      // Reviewer cannot be assigned
      mockRepo.findProjectMember.mockResolvedValueOnce(
        fromPartial({ userId: 'user-rev', role: 'reviewer' }),
      );
      await expect(
        service.assignWorkItem('proj-1', 'wi-1', 'user-rev', 'actor-1'),
      ).rejects.toThrow(BadRequestException);

      // Join & Leave
      mockRepo.findProjectMember.mockResolvedValueOnce(
        fromPartial({ userId: 'user-1', role: 'owner' }),
      );
      mockRepo.assignWorkItem.mockResolvedValueOnce(
        fromPartial({ id: 'wi-1', projectId: 'proj-1', assigneeId: 'user-1' }),
      );
      await expect(
        service.joinWorkItem('proj-1', 'wi-1', 'user-1'),
      ).resolves.toMatchObject({ newAssigneeId: 'user-1' });

      mockRepo.findWorkItemWithProject.mockResolvedValueOnce(
        fromPartial({ id: 'wi-1', projectId: 'proj-1', assigneeId: 'user-1' }),
      );
      mockRepo.assignWorkItem.mockResolvedValueOnce(
        fromPartial({ id: 'wi-1', projectId: 'proj-1', assigneeId: null }),
      );
      await expect(
        service.leaveWorkItem('proj-1', 'wi-1', 'user-1'),
      ).resolves.toMatchObject({ newAssigneeId: null });

      // Multi-assignee primary failover
      mockRepo.findWorkItemWithProject.mockResolvedValue(
        fromPartial({
          id: 'wi-1',
          projectId: 'proj-1',
          assigneeId: 'u-1',
          assigneeIds: ['u-1', 'u-2'],
        }),
      );
      mockRepo.findProjectMembers.mockResolvedValue([
        fromPartial({ userId: 'u-1', role: 'owner' }),
        fromPartial({ userId: 'u-2', role: 'contributor' }),
      ]);
      await expect(
        service.setAssignees('proj-1', 'wi-1', { assigneeIds: ['u-1', 'u-2'] }, 'u-1'),
      ).resolves.toEqual({ assignees: ['u-1', 'u-2'], primaryAssigneeId: 'u-1' });

      await expect(
        service.removeAssignee('proj-1', 'wi-1', 'u-1', 'u-1'),
      ).resolves.toEqual({ assignees: ['u-2'], primaryAssigneeId: 'u-2' });

      // Subscriptions
      mockRepo.findWorkItemWithProject.mockResolvedValueOnce(
        fromPartial({ id: 'wi-1', projectId: 'proj-1', subscriberIds: [] }),
      );
      await expect(
        service.subscribeMe('proj-1', 'wi-1', 'u-1'),
      ).resolves.toMatchObject({ subscribers: ['u-1'] });

      mockRepo.findWorkItemWithProject.mockResolvedValueOnce(
        fromPartial({ id: 'wi-1', projectId: 'proj-1', subscriberIds: ['u-1'] }),
      );
      await expect(
        service.unsubscribeMe('proj-1', 'wi-1', 'u-1'),
      ).resolves.toMatchObject({ subscribers: [] });
    });
  });

  describe('DraftService', () => {
    it('creates, duplicates, publishes drafts via CoreService.createWorkItem, and blocks drafts missing projectId', async () => {
      const mockDraftRepo = fromPartial<jest.Mocked<DraftRepository>>({
        create: jest.fn(),
        findById: jest.fn(),
        delete: jest.fn(),
      });
      const createWorkItem = jest.fn();
      const emit = jest.fn();
      const service = new DraftService(
        mockDraftRepo,
        fromPartial<CoreService>({ createWorkItem }),
        fromPartial<EventEmitter2>({ emit }),
      );

      mockDraftRepo.create.mockResolvedValueOnce(
        fromPartial({ id: 'draft-1', title: 'My Draft', projectId: 'proj-1' }),
      );
      const created = await service.createDraft(
        { title: 'My Draft', projectId: 'proj-1' },
        'user-1',
      );
      expect(created.id).toBe('draft-1');

      mockDraftRepo.findById.mockResolvedValueOnce(
        fromPartial({
          id: 'draft-1',
          title: 'Draft Issue',
          content: 'Specs',
          description: 'Specs',
          columnId: 'todo',
          priority: 'high',
          projectId: 'proj-1',
          labels: ['bug'],
          assigneeId: 'user-1',
          assigneeIds: ['user-1'],
        }),
      );
      createWorkItem.mockResolvedValueOnce({
        workItem: { id: 'wi-published-1', identifier: 'FLUX-10' },
        item: { id: 'wi-published-1', identifier: 'FLUX-10' },
      });

      const published = await service.publishDraft('draft-1', {}, 'user-1');
      expect(published.workItem?.id).toBe('wi-published-1');
      expect(mockDraftRepo.delete).toHaveBeenCalledWith('draft-1', 'user-1');

      mockDraftRepo.findById.mockResolvedValueOnce(
        fromPartial({ id: 'draft-orphan', title: 'Orphan', projectId: null }),
      );
      await expect(
        service.publishDraft('draft-orphan', {}, 'user-1'),
      ).rejects.toThrow(BadRequestException);

      mockDraftRepo.findById.mockResolvedValueOnce(
        fromPartial({
          id: 'draft-1',
          title: 'Original',
          content: 'Body',
          priority: 'medium',
          labels: [],
          projectId: 'proj-1',
        }),
      );
      mockDraftRepo.create.mockResolvedValueOnce(
        fromPartial({ id: 'draft-2', title: 'Original (Copy)', projectId: 'proj-1' }),
      );
      await expect(
        service.duplicateDraft('draft-1', 'user-1'),
      ).resolves.toMatchObject({ title: 'Original (Copy)' });
    });
  });

  describe('LabelService, LabelRepository & StateService', () => {
    it('enforces 1-level label hierarchy, detaches children on delete, and applies root/sub Prisma filters', async () => {
      const detachMultipleFromWorkItems = jest.fn().mockResolvedValue(2);
      const mockLabelRepo = fromPartial<jest.Mocked<LabelRepository>>({
        findProject: jest.fn().mockResolvedValue({ id: 'proj-1' }),
        findByNameInProject: jest.fn().mockResolvedValue(null),
        getLastSortOrder: jest.fn().mockResolvedValue(10000),
        findById: jest.fn(async (id: string) => {
          if (id === 'parent-1') {
            return fromPartial({ id: 'parent-1', projectId: 'proj-1', parentId: null, children: [] });
          }
          if (id === 'sub-1') {
            return fromPartial({ id: 'sub-1', projectId: 'proj-1', parentId: 'parent-1', children: [] });
          }
          if (id === 'lbl-with-kids') {
            return fromPartial({
              id: 'lbl-with-kids',
              name: 'Backend',
              projectId: 'proj-1',
              parentId: null,
              children: [{ id: 'lbl-child', name: 'Prisma' }],
            });
          }
          return null;
        }),
        create: jest.fn(async (data) => fromPartial({ id: 'lbl-1', ...data })),
        delete: jest.fn(),
        detachMultipleFromWorkItems,
      });
      const delCache = jest.fn().mockResolvedValue(undefined);
      const service = new LabelService(
        mockLabelRepo,
        fromPartial<RedisCacheService>({
          get: jest.fn().mockResolvedValue(null),
          set: jest.fn().mockResolvedValue(undefined),
          del: delCache,
          delPattern: jest.fn().mockResolvedValue(undefined),
        }),
      );

      const created = await service.createProjectLabel('proj-1', 'user-1', {
        name: 'Frontend',
        parentId: 'parent-1',
      });
      expect(created.label.sortOrder).toBe(20000);
      expect(delCache).toHaveBeenCalledWith('flux:wi:work-items:proj-1');

      await expect(
        service.updateProjectLabel('proj-1', 'parent-1', {
          parentId: 'parent-1',
        }),
      ).rejects.toThrow('A label cannot be its own parent');

      await expect(
        service.createProjectLabel('proj-1', 'user-1', {
          name: 'Grandchild',
          parentId: 'sub-1',
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.updateProjectLabel('proj-1', 'lbl-with-kids', {
          parentId: 'parent-1',
        }),
      ).rejects.toThrow(BadRequestException);

      await service.deleteProjectLabel('proj-1', 'lbl-with-kids');
      expect(detachMultipleFromWorkItems).toHaveBeenCalledWith(
        'proj-1',
        ['lbl-with-kids', 'lbl-child'],
        ['Backend', 'Prisma'],
      );

      const spaceLabelFindMany = jest.fn().mockResolvedValue([]);
      const realRepo = new LabelRepository(
        fromPartial<PrismaService>({
          spaceLabel: { findMany: spaceLabelFindMany },
        }),
      );
      await realRepo.findProjectLabels('proj-1', 'root');
      expect(spaceLabelFindMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { spaceId: 'proj-1', parentId: null } }),
      );
      await realRepo.findProjectLabels('proj-1', 'sub');
      expect(spaceLabelFindMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { spaceId: 'proj-1', parentId: { not: null } },
        }),
      );
    });

    it('manages work-item states, default promotion, completion group migration, and fallback deletion', async () => {
      const sampleStates = [
        {
          id: 'st-todo',
          name: 'To Do',
          title: 'To Do',
          color: '#64748b',
          accentColor: '#64748b',
          icon: 'circle-dashed',
          group: 'unstarted' as const,
          sequence: 1000,
          isDefault: true,
        },
        {
          id: 'st-done',
          name: 'Done',
          title: 'Done',
          color: '#10b981',
          accentColor: '#10b981',
          icon: 'check-circle',
          group: 'completed' as const,
          sequence: 2000,
          isDefault: false,
        },
      ];
      const migrateWorkItemsToState = jest.fn().mockResolvedValue(2);
      const deleteStateWithWorkItemMigration = jest.fn().mockResolvedValue(undefined);
      const countWorkItemsInState = jest.fn().mockResolvedValue(0);

      const service = new StateService(
        fromPartial<StateRepository>({
          findProjectById: jest.fn().mockResolvedValue({ id: 'proj-1' }),
          findProjectStates: jest.fn(async () => sampleStates.map((s) => ({ ...s }))),
          saveProjectStates: jest.fn(async (_p, states) => states),
          countWorkItemsByState: jest.fn().mockResolvedValue({ 'st-todo': 3 }),
          countWorkItemsInState,
          migrateWorkItemsToState,
          deleteStateWithWorkItemMigration,
        }),
        fromPartial<EventEmitter2>({ emit: jest.fn() }),
        fromPartial<RedisCacheService>({ del: jest.fn().mockResolvedValue(undefined) }),
      );

      const created = await service.createState(
        'proj-1',
        { name: 'In Review', group: 'started', isDefault: true },
        'user-1',
      );
      expect(created.state.isDefault).toBe(true);
      expect(created.states.find((s) => s.id === 'st-todo')?.isDefault).toBe(false);

      await service.updateState(
        'proj-1',
        'st-todo',
        { group: 'completed' },
        'user-1',
      );
      expect(migrateWorkItemsToState).toHaveBeenCalledWith(
        'proj-1',
        'st-todo',
        'st-todo',
        true,
      );

      await expect(
        service.deleteState('proj-1', 'st-todo', 'st-done'),
      ).rejects.toThrow(BadRequestException);

      countWorkItemsInState.mockResolvedValueOnce(5);
      await expect(
        service.deleteState('proj-1', 'st-done', undefined),
      ).rejects.toThrow(BadRequestException);

      countWorkItemsInState.mockResolvedValueOnce(4);
      await expect(
        service.deleteState('proj-1', 'st-done', 'st-todo', 'user-1'),
      ).resolves.toMatchObject({ migratedTo: 'st-todo' });
      expect(deleteStateWithWorkItemMigration).toHaveBeenCalled();
    });
  });

  describe('CommentService, HistoryService & WorkItemFacade', () => {
    it('parses comment mentions, enforces owner moderation deletes, and handles reactions + replies', async () => {
      const mockCommentRepo = fromPartial<jest.Mocked<CommentRepository>>({
        createComment: jest.fn(),
        findCommentWithProject: jest.fn(),
        findCommentById: jest.fn(),
        findAuthorById: jest.fn(),
        updateComment: jest.fn(async (_id, data) =>
          fromPartial({ id: 'cmt-1', ...data }),
        ),
        deleteComment: jest.fn(),
        findProjectMemberRole: jest.fn(),
      });
      const emit = jest.fn();
      const service = new CommentService(
        mockCommentRepo,
        fromPartial<EventEmitter2>({ emit }),
      );

      const content =
        'Hello @[Alice](user-alice) and @[Bob](user-bob), cc @[Alice](user-alice)';
      mockCommentRepo.createComment.mockResolvedValueOnce(
        fromPartial({ id: 'cmt-1', workItemId: 'wi-1', authorId: 'user-1', content }),
      );
      await service.createComment('wi-1', 'user-1', { content });
      expect(emit).toHaveBeenCalledWith('comment.mention', {
        workItemId: 'wi-1',
        commentId: 'cmt-1',
        authorId: 'user-1',
        mentionedUserIds: ['user-alice', 'user-bob'],
      });

      mockCommentRepo.findCommentWithProject.mockResolvedValue(
        fromPartial({
          id: 'cmt-1',
          authorId: 'other-user',
          workItemId: 'wi-1',
          workItem: {
            projectId: 'proj-1',
            project: { id: 'proj-1', createdById: 'proj-creator' },
          },
        }),
      );
      mockCommentRepo.findProjectMemberRole.mockResolvedValueOnce('contributor');
      await expect(
        service.deleteComment('cmt-1', 'non-owner-user'),
      ).rejects.toThrow(ForbiddenException);

      mockCommentRepo.findProjectMemberRole.mockResolvedValueOnce('owner');
      await expect(
        service.deleteComment('cmt-1', 'owner-user'),
      ).resolves.toMatchObject({ success: true });

      mockCommentRepo.findCommentById.mockResolvedValue(
        fromPartial({ id: 'cmt-1', reactions: { '👍': ['user-2'] }, replies: [] }),
      );
      const reactRes = await service.reactToComment('cmt-1', 'user-1', {
        emoji: '👍',
      });
      expect(
        (reactRes.comment.reactions as Record<string, string[]>)['👍'],
      ).toEqual(['user-2', 'user-1']);

      mockCommentRepo.findAuthorById.mockResolvedValue(
        fromPartial({ id: 'user-1', name: 'User One', email: 'u1@example.com', avatar: null }),
      );
      const replyRes = await service.addReply('cmt-1', 'user-1', {
        content: 'LGTM!',
      });
      expect(replyRes.comment.replies).toHaveLength(1);
    });

    it('formats HistoryService diffs and delegates WorkItemFacade queries cleanly', async () => {
      const historyService = new HistoryService(
        fromPartial<HistoryRepository>({
          findWorkItemActivityEvents: jest.fn().mockResolvedValue([
            {
              id: 'ev-1',
              field: 'priority',
              oldValue: 'low',
              newValue: 'urgent',
              verb: 'updated',
              actor: { id: 'u-1', name: 'Alice' },
            },
            {
              id: 'ev-2',
              field: null,
              oldValue: null,
              newValue: null,
              verb: 'created',
              actor: { id: 'u-1', name: 'Alice' },
            },
          ]),
        }),
      );
      const activity = await historyService.getActivity('wi-1', 'desc');
      expect(activity.activities.map((a) => a.message)).toEqual([
        'Changed priority from "low" to "urgent"',
        'Alice created this item',
      ]);

      expect(summarizeDiff('title', 'Old Title', 'New Title')).toBe(
        'Changed title from "Old Title" to "New Title"',
      );
      expect(summarizeDiff('description', 'abc', 'abcdef')).toBe(
        'Updated description (+3 chars)',
      );
      expect(summarizeDiff('dueDate', null, '2026-12-01')).toBe(
        'Changed due date to 2026-12-01 (was (none))',
      );

      const now = new Date();
      const facade = new WorkItemFacade(
        fromPartial<CoreRepository>({
          findWorkItemById: jest.fn().mockResolvedValue({
            id: 'wi-1',
            identifier: 'FLUX-1',
            sequenceNumber: 1,
            title: 'Facade Item',
            columnId: 'col-1',
            priority: 'high',
            projectId: 'proj-1',
            authorId: 'u-1',
            assigneeId: 'u-2',
            dueDate: now,
            completed: false,
            createdAt: now,
            updatedAt: now,
          }),
          countProjectWorkItems: jest.fn().mockResolvedValue(12),
        }),
        fromPartial<StateService>({
          getStateWorkItemCounts: jest.fn().mockResolvedValue({ 'col-1': 5 }),
        }),
        fromPartial<AttachmentService>({
          getWorkItemsByLinkedEntity: jest.fn().mockResolvedValue([]),
        }),
        fromPartial<AssignmentService>({
          getAssignees: jest
            .fn()
            .mockResolvedValue({ assignees: [{ id: 'u-2' }] } as never),
        }),
        fromPartial<RelationService>({
          getWorkItemRelations: jest
            .fn()
            .mockResolvedValue({ relations: [] } as never),
        }),
        historyService,
      );

      expect((await facade.getWorkItemById('FLUX-1'))?.identifier).toBe('FLUX-1');
      expect(await facade.countWorkItemsByProject('proj-1')).toBe(12);
      expect(await facade.getWorkItemAssignees('wi-1')).toEqual([{ id: 'u-2' }]);
    });
  });
});
