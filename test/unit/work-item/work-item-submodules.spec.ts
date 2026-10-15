import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EntityType } from '@prisma/client';
import { ArchiveService } from '@/modules/work-item/archive/archive.service';
import { AssignmentService } from '@/modules/work-item/assignment/assignment.service';
import { DraftService } from '@/modules/work-item/draft/draft.service';
import { LabelService } from '@/modules/work-item/label/label.service';
import { LabelRepository } from '@/modules/work-item/label/label.repository';
import { StateService } from '@/modules/work-item/state/state.service';
import { CommentService } from '@/modules/work-item/comment/comment.service';
import { HistoryService } from '@/modules/work-item/history/history.service';
import { summarizeDiff } from '@/modules/work-item/history/utils/diff.util';
import { WorkItemFacade } from '@/modules/work-item/work-item.facade';
import { CoreService } from '@/modules/work-item/core/core.service';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';

describe('Work-Item Submodules Comprehensive Unit Suite', () => {
  // ── 1. ArchiveService ──────────────────────────────────────────────────────
  describe('ArchiveService', () => {
    let service: ArchiveService;
    let mockRepo: any;
    let mockEvents: any;
    let mockCache: any;

    beforeEach(() => {
      mockRepo = {
        findWorkItemWithProject: jest.fn(),
        archiveWorkItem: jest.fn(),
        restoreWorkItem: jest.fn(),
        findWorkItemsByIds: jest.fn(),
        bulkArchive: jest.fn(),
        bulkRestore: jest.fn(),
        findArchivedWorkItems: jest.fn(),
      };
      mockEvents = { emit: jest.fn() };
      mockCache = { del: jest.fn().mockResolvedValue(undefined) };

      service = new ArchiveService(mockRepo, mockEvents, mockCache);
    });

    it('should archive an active work item, invalidate cache, and emit aligned work-item.archived event', async () => {
      const workItem = {
        id: 'wi-1',
        identifier: 'FLUX-1',
        projectId: 'proj-1',
        archivedAt: null,
      };
      const updated = { ...workItem, archivedAt: new Date() };
      mockRepo.findWorkItemWithProject.mockResolvedValue(workItem);
      mockRepo.archiveWorkItem.mockResolvedValue(updated);

      const res = await service.archiveWorkItem('wi-1', 'user-1');

      expect(res.success).toBe(true);
      expect(res.workItem).toEqual(updated);
      expect(mockRepo.archiveWorkItem).toHaveBeenCalledWith('wi-1');
      expect(mockCache.del).toHaveBeenCalled();
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'work-item.archived',
        expect.objectContaining({
          entityType: EntityType.work_item,
          entityId: 'wi-1',
          workItemId: 'wi-1',
          projectId: 'proj-1',
          verb: 'archived',
          actorId: 'user-1',
          userId: 'user-1',
        }),
      );
    });

    it('should reject archiving an already archived work item', async () => {
      mockRepo.findWorkItemWithProject.mockResolvedValue({
        id: 'wi-1',
        identifier: 'FLUX-1',
        projectId: 'proj-1',
        archivedAt: new Date(),
      });

      await expect(service.archiveWorkItem('wi-1', 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should restore an archived work item and emit work-item.restored', async () => {
      const workItem = {
        id: 'wi-1',
        identifier: 'FLUX-1',
        projectId: 'proj-1',
        archivedAt: new Date(),
      };
      const restored = { ...workItem, archivedAt: null };
      mockRepo.findWorkItemWithProject.mockResolvedValue(workItem);
      mockRepo.restoreWorkItem.mockResolvedValue(restored);

      const res = await service.restoreWorkItem('wi-1', 'user-1');

      expect(res.success).toBe(true);
      expect(mockRepo.restoreWorkItem).toHaveBeenCalledWith('wi-1');
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'work-item.restored',
        expect.objectContaining({
          entityId: 'wi-1',
          verb: 'restored',
          actorId: 'user-1',
        }),
      );
    });

    it('should bulk archive work items and emit activity.event for each item', async () => {
      const items = [
        { id: 'wi-1', projectId: 'proj-1' },
        { id: 'wi-2', projectId: 'proj-1' },
      ];
      mockRepo.findWorkItemsByIds.mockResolvedValue(items);
      mockRepo.bulkArchive.mockResolvedValue({ count: 2 });

      const res = await service.bulkArchiveWorkItems(
        { workItemIds: ['wi-1', 'wi-2'], reason: 'Sprint cleanup' },
        'user-1',
      );

      expect(res.count).toBe(2);
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'work-item.bulk-archived',
        expect.objectContaining({
          workItemIds: ['wi-1', 'wi-2'],
          count: 2,
          actorId: 'user-1',
          reason: 'Sprint cleanup',
        }),
      );
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'activity.event',
        expect.any(DomainActivityEvent),
      );
    });

    it('should list archived work items with backward-compatible archivedItems and count fields', async () => {
      mockRepo.findArchivedWorkItems.mockResolvedValue({
        workItems: [{ id: 'wi-arch-1' }],
        total: 1,
        page: 1,
        limit: 50,
      });

      const res = await service.getArchivedWorkItems('proj-1', { page: 1 });
      expect(res.archivedItems).toHaveLength(1);
      expect(res.count).toBe(1);
    });
  });

  // ── 2. AssignmentService ───────────────────────────────────────────────────
  describe('AssignmentService', () => {
    let service: AssignmentService;
    let mockRepo: any;
    let mockEvents: any;
    let mockCache: any;

    beforeEach(() => {
      mockRepo = {
        findWorkItemWithProject: jest.fn(),
        findProjectMember: jest.fn(),
        findProjectMembers: jest.fn(),
        assignWorkItem: jest.fn(),
        bulkAssignWorkItems: jest.fn(),
        findEligibleAssignees: jest.fn(),
        getProjectSettings: jest.fn(),
        findUsersByIds: jest.fn(),
        setAssigneeIds: jest.fn(),
        setSubscriberIds: jest.fn(),
      };
      mockEvents = { emit: jest.fn() };
      mockCache = { del: jest.fn().mockResolvedValue(undefined) };

      service = new AssignmentService(mockRepo, mockEvents, mockCache);
    });

    it('should assign work item to an eligible contributor and emit events', async () => {
      const item = {
        id: 'wi-1',
        identifier: 'FLUX-1',
        projectId: 'proj-1',
        assigneeId: null,
      };
      mockRepo.findWorkItemWithProject.mockResolvedValue(item);
      mockRepo.findProjectMember.mockResolvedValue({
        userId: 'user-2',
        role: 'contributor',
      });
      mockRepo.assignWorkItem.mockResolvedValue({
        ...item,
        assigneeId: 'user-2',
      });

      const res = await service.assignWorkItem(
        'proj-1',
        'wi-1',
        'user-2',
        'actor-1',
      );

      expect(res.newAssigneeId).toBe('user-2');
      expect(mockRepo.assignWorkItem).toHaveBeenCalledWith('wi-1', 'user-2');
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'work-item.assigned',
        expect.objectContaining({
          entityId: 'wi-1',
          newValue: 'user-2',
          actorId: 'actor-1',
        }),
      );
    });

    it('should reject assigning work item to a reviewer', async () => {
      mockRepo.findWorkItemWithProject.mockResolvedValue({
        id: 'wi-1',
        projectId: 'proj-1',
        assigneeId: null,
      });
      mockRepo.findProjectMember.mockResolvedValue({
        userId: 'user-rev',
        role: 'reviewer',
      });

      await expect(
        service.assignWorkItem('proj-1', 'wi-1', 'user-rev', 'actor-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow eligible member to join and leave work item', async () => {
      mockRepo.findWorkItemWithProject.mockResolvedValueOnce({
        id: 'wi-1',
        projectId: 'proj-1',
        assigneeId: null,
      });
      mockRepo.findProjectMember.mockResolvedValueOnce({
        userId: 'user-1',
        role: 'owner',
      });
      mockRepo.assignWorkItem.mockResolvedValueOnce({
        id: 'wi-1',
        projectId: 'proj-1',
        assigneeId: 'user-1',
      });

      const joinRes = await service.joinWorkItem('proj-1', 'wi-1', 'user-1');
      expect(joinRes.newAssigneeId).toBe('user-1');

      mockRepo.findWorkItemWithProject.mockResolvedValueOnce({
        id: 'wi-1',
        projectId: 'proj-1',
        assigneeId: 'user-1',
      });
      mockRepo.assignWorkItem.mockResolvedValueOnce({
        id: 'wi-1',
        projectId: 'proj-1',
        assigneeId: null,
      });

      const leaveRes = await service.leaveWorkItem('proj-1', 'wi-1', 'user-1');
      expect(leaveRes.newAssigneeId).toBeNull();
    });

    it('should manage multi-assignees (setAssignees, addAssignee, removeAssignee)', async () => {
      const item = {
        id: 'wi-1',
        projectId: 'proj-1',
        assigneeId: 'u-1',
        assigneeIds: ['u-1'],
      };
      mockRepo.findWorkItemWithProject.mockResolvedValue(item);
      mockRepo.findProjectMembers.mockResolvedValue([
        { userId: 'u-1', role: 'owner' },
        { userId: 'u-2', role: 'contributor' },
      ]);

      const setRes = await service.setAssignees(
        'proj-1',
        'wi-1',
        { assigneeIds: ['u-1', 'u-2'] },
        'u-1',
      );
      expect(setRes).toEqual({
        assignees: ['u-1', 'u-2'],
        primaryAssigneeId: 'u-1',
      });

      // Remove primary assignee u-1 -> u-2 becomes primary
      mockRepo.findWorkItemWithProject.mockResolvedValueOnce({
        ...item,
        assigneeIds: ['u-1', 'u-2'],
      });
      const remRes = await service.removeAssignee(
        'proj-1',
        'wi-1',
        'u-1',
        'u-1',
      );
      expect(remRes).toEqual({
        assignees: ['u-2'],
        primaryAssigneeId: 'u-2',
      });
    });

    it('should subscribe and unsubscribe user from work item notifications', async () => {
      mockRepo.findWorkItemWithProject.mockResolvedValue({
        id: 'wi-1',
        projectId: 'proj-1',
        subscriberIds: [],
      });

      const subRes = await service.subscribeMe('proj-1', 'wi-1', 'u-1');
      expect(subRes.subscribers).toEqual(['u-1']);

      mockRepo.findWorkItemWithProject.mockResolvedValue({
        id: 'wi-1',
        projectId: 'proj-1',
        subscriberIds: ['u-1'],
      });

      const unsubRes = await service.unsubscribeMe('proj-1', 'wi-1', 'u-1');
      expect(unsubRes.subscribers).toEqual([]);
    });
  });

  // ── 3. DraftService ────────────────────────────────────────────────────────
  describe('DraftService', () => {
    let service: DraftService;
    let mockDraftRepo: any;
    let mockWorkItemService: any;
    let mockEvents: any;

    beforeEach(() => {
      mockDraftRepo = {
        create: jest.fn(),
        findById: jest.fn(),
        findUserDrafts: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      };
      mockWorkItemService = {
        createWorkItem: jest.fn(),
      };
      mockEvents = { emit: jest.fn() };

      service = new DraftService(
        mockDraftRepo,
        mockWorkItemService,
        mockEvents,
      );
    });

    it('should create a draft and emit draft.created', async () => {
      mockDraftRepo.create.mockResolvedValue({
        id: 'draft-1',
        title: 'My Draft',
        projectId: 'proj-1',
      });

      const res = await service.createDraft(
        { title: 'My Draft', projectId: 'proj-1' },
        'user-1',
      );

      expect(res.id).toBe('draft-1');
      expect(mockEvents.emit).toHaveBeenCalledWith('draft.created', {
        draftId: 'draft-1',
        authorId: 'user-1',
        projectId: 'proj-1',
      });
    });

    it('should publish draft via WorkItemService.createWorkItem, delete draft, and emit draft.published', async () => {
      mockDraftRepo.findById.mockResolvedValue({
        id: 'draft-1',
        title: 'Draft Issue',
        content: 'Detailed specs',
        description: 'Detailed specs',
        columnId: 'todo',
        priority: 'high',
        projectId: 'proj-1',
        labels: ['bug'],
        startDate: null,
        dueDate: null,
        assigneeId: 'user-1',
        assigneeIds: ['user-1'],
      });
      mockWorkItemService.createWorkItem.mockResolvedValue({
        workItem: { id: 'wi-published-1', identifier: 'FLUX-10' },
        item: { id: 'wi-published-1', identifier: 'FLUX-10' },
      });

      const res = await service.publishDraft('draft-1', {}, 'user-1');

      expect(mockWorkItemService.createWorkItem).toHaveBeenCalledWith(
        'proj-1',
        'user-1',
        expect.objectContaining({
          title: 'Draft Issue',
          columnId: 'todo',
          priority: 'high',
          labels: ['bug'],
        }),
      );
      expect(mockDraftRepo.delete).toHaveBeenCalledWith('draft-1', 'user-1');
      expect(mockEvents.emit).toHaveBeenCalledWith('draft.published', {
        draftId: 'draft-1',
        workItemId: 'wi-published-1',
        projectId: 'proj-1',
        authorId: 'user-1',
      });
      expect(res.workItem?.id).toBe('wi-published-1');
    });

    it('should throw BadRequestException when publishing a draft without projectId', async () => {
      mockDraftRepo.findById.mockResolvedValue({
        id: 'draft-no-proj',
        title: 'Orphan Draft',
        projectId: null,
      });

      await expect(
        service.publishDraft('draft-no-proj', {}, 'user-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should duplicate a draft with (Copy) suffix', async () => {
      mockDraftRepo.findById.mockResolvedValue({
        id: 'draft-1',
        title: 'Original',
        content: 'Body',
        priority: 'medium',
        labels: [],
        projectId: 'proj-1',
      });
      mockDraftRepo.create.mockResolvedValue({
        id: 'draft-2',
        title: 'Original (Copy)',
        projectId: 'proj-1',
      });

      const res = await service.duplicateDraft('draft-1', 'user-1');
      expect(res.title).toBe('Original (Copy)');
      expect(mockDraftRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Original (Copy)' }),
        'user-1',
      );
    });
  });

  // ── 4. LabelService & LabelRepository ──────────────────────────────────────
  describe('LabelService & LabelRepository', () => {
    let service: LabelService;
    let mockLabelRepo: any;
    let mockCache: any;

    beforeEach(() => {
      mockLabelRepo = {
        findProject: jest.fn().mockResolvedValue({ id: 'proj-1' }),
        findProjectLabels: jest.fn().mockResolvedValue([]),
        findUserLabels: jest.fn().mockResolvedValue([]),
        findById: jest.fn(),
        findByNameInProject: jest.fn(),
        findDuplicate: jest.fn(),
        getLastSortOrder: jest.fn().mockResolvedValue(10000),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        reorder: jest.fn(),
        detachMultipleFromWorkItems: jest.fn().mockResolvedValue(2),
      };
      mockCache = {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        del: jest.fn().mockResolvedValue(undefined),
        delPattern: jest.fn().mockResolvedValue(undefined),
      };

      service = new LabelService(mockLabelRepo, mockCache);
    });

    it('should create a project label, enforce 1-level nesting, and invalidate project work-item cache', async () => {
      mockLabelRepo.findByNameInProject.mockResolvedValue(null);
      mockLabelRepo.findById.mockResolvedValue({
        id: 'parent-1',
        projectId: 'proj-1',
        parentId: null,
      });
      mockLabelRepo.create.mockImplementation((data: any) =>
        Promise.resolve({ id: 'lbl-1', ...data }),
      );

      const res = await service.createProjectLabel('proj-1', 'user-1', {
        name: 'Frontend',
        parentId: 'parent-1',
      });

      expect(res.label.name).toBe('Frontend');
      expect(res.label.sortOrder).toBe(20000);
      expect(mockCache.del).toHaveBeenCalledWith('flux:wi:work-items:proj-1');
    });

    it('should reject nesting a label under a sub-label (max depth 1)', async () => {
      mockLabelRepo.findByNameInProject.mockResolvedValue(null);
      mockLabelRepo.findById.mockResolvedValue({
        id: 'sub-1',
        projectId: 'proj-1',
        parentId: 'root-1',
      });

      await expect(
        service.createProjectLabel('proj-1', 'user-1', {
          name: 'Too Deep',
          parentId: 'sub-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should detach deleted label and its children from work items and invalidate work-item cache', async () => {
      mockLabelRepo.findById.mockResolvedValue({
        id: 'lbl-parent',
        name: 'Backend',
        projectId: 'proj-1',
        createdById: 'user-1',
        children: [{ id: 'lbl-child', name: 'Prisma' }],
      });

      const res = await service.deleteProjectLabel('proj-1', 'lbl-parent');

      expect(mockLabelRepo.detachMultipleFromWorkItems).toHaveBeenCalledWith(
        'proj-1',
        ['lbl-parent', 'lbl-child'],
        ['Backend', 'Prisma'],
      );
      expect(mockLabelRepo.delete).toHaveBeenCalledWith('lbl-parent');
      expect(res.labelId).toBe('lbl-parent');
      expect(mockCache.del).toHaveBeenCalledWith('flux:wi:work-items:proj-1');
    });

    it('LabelRepository.findProjectLabels should apply hierarchy type filter when type is provided', async () => {
      const mockPrisma = {
        workItemLabel: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };
      const repo = new LabelRepository(mockPrisma as any);

      await repo.findProjectLabels('proj-1', 'root');
      expect(mockPrisma.workItemLabel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { projectId: 'proj-1', parentId: null },
        }),
      );

      await repo.findProjectLabels('proj-1', 'sub');
      expect(mockPrisma.workItemLabel.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { projectId: 'proj-1', parentId: { not: null } },
        }),
      );
    });
  });

  // ── 5. StateService ────────────────────────────────────────────────────────
  describe('StateService', () => {
    let service: StateService;
    let mockStateRepo: any;
    let mockEvents: any;
    let mockCache: any;

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

    beforeEach(() => {
      mockStateRepo = {
        findProjectById: jest.fn().mockResolvedValue({ id: 'proj-1' }),
        findProjectStates: jest.fn().mockResolvedValue([...sampleStates]),
        saveProjectStates: jest
          .fn()
          .mockImplementation((_p, states) => Promise.resolve(states)),
        countWorkItemsByState: jest.fn().mockResolvedValue({ 'st-todo': 3 }),
        countWorkItemsInState: jest.fn().mockResolvedValue(0),
        migrateWorkItemsToState: jest.fn().mockResolvedValue(2),
        deleteStateWithWorkItemMigration: jest
          .fn()
          .mockResolvedValue(undefined),
      };
      mockEvents = { emit: jest.fn() };
      mockCache = { del: jest.fn().mockResolvedValue(undefined) };

      service = new StateService(mockStateRepo, mockEvents, mockCache);
    });

    it('should create a new state and unset previous default if new state isDefault', async () => {
      const res = await service.createState(
        'proj-1',
        {
          name: 'In Review',
          group: 'started',
          isDefault: true,
        },
        'user-1',
      );

      expect(res.state.name).toBe('In Review');
      expect(res.state.isDefault).toBe(true);
      const oldDefault = res.states.find((s) => s.id === 'st-todo');
      expect(oldDefault?.isDefault).toBe(false);
      expect(mockEvents.emit).toHaveBeenCalledWith(
        'state.created',
        expect.objectContaining({ projectId: 'proj-1' }),
      );
    });

    it('should migrate work items completion flag when state group changes to completed', async () => {
      await service.updateState(
        'proj-1',
        'st-todo',
        { group: 'completed' },
        'user-1',
      );

      expect(mockStateRepo.migrateWorkItemsToState).toHaveBeenCalledWith(
        'proj-1',
        'st-todo',
        'st-todo',
        true,
      );
    });

    it('should prevent deleting the default state or deleting a populated state without fallback', async () => {
      await expect(
        service.deleteState('proj-1', 'st-todo', 'st-done'),
      ).rejects.toThrow(BadRequestException);

      mockStateRepo.countWorkItemsInState.mockResolvedValueOnce(5);
      await expect(
        service.deleteState('proj-1', 'st-done', undefined),
      ).rejects.toThrow(BadRequestException);
    });

    it('should safely delete a non-default state and migrate work items to fallback state', async () => {
      mockStateRepo.countWorkItemsInState.mockResolvedValueOnce(4);

      const res = await service.deleteState(
        'proj-1',
        'st-done',
        'st-todo',
        'user-1',
      );

      expect(
        mockStateRepo.deleteStateWithWorkItemMigration,
      ).toHaveBeenCalledWith(
        'proj-1',
        'st-done',
        'st-todo',
        expect.any(Array),
        false,
      );
      expect(res.migratedTo).toBe('st-todo');
    });
  });

  // ── 6. CommentService ──────────────────────────────────────────────────────
  describe('CommentService', () => {
    let service: CommentService;
    let mockCommentRepo: any;
    let mockEvents: any;

    beforeEach(() => {
      mockCommentRepo = {
        findWorkItemComments: jest.fn().mockResolvedValue([]),
        createComment: jest.fn(),
        findCommentWithProject: jest.fn(),
        findCommentById: jest.fn(),
        findAuthorById: jest.fn(),
        updateComment: jest.fn(),
        deleteComment: jest.fn(),
        findProjectMemberRole: jest.fn(),
      };
      mockEvents = { emit: jest.fn() };

      service = new CommentService(mockCommentRepo, mockEvents);
    });

    it('should create comment, parse @[Name](userId) mentions, and emit comment.mention + comment.created', async () => {
      const content =
        'Hello @[Alice](user-alice) and @[Bob](user-bob), please review @[Alice](user-alice)';
      mockCommentRepo.createComment.mockResolvedValue({
        id: 'cmt-1',
        workItemId: 'wi-1',
        authorId: 'user-1',
        content,
      });

      const res = await service.createWorkItemComment('wi-1', 'user-1', {
        content,
      });

      expect(res.comment.id).toBe('cmt-1');
      expect(mockEvents.emit).toHaveBeenCalledWith('comment.mention', {
        workItemId: 'wi-1',
        commentId: 'cmt-1',
        authorId: 'user-1',
        mentionedUserIds: ['user-alice', 'user-bob'],
      });
      expect(mockEvents.emit).toHaveBeenCalledWith('comment.created', {
        workItemId: 'wi-1',
        commentId: 'cmt-1',
        authorId: 'user-1',
        content,
      });
    });

    it('should allow project owner to delete another user comment, but forbid non-owner', async () => {
      mockCommentRepo.findCommentWithProject.mockResolvedValue({
        id: 'cmt-1',
        authorId: 'other-user',
        workItemId: 'wi-1',
        workItem: {
          projectId: 'proj-1',
          project: { id: 'proj-1', createdById: 'proj-creator' },
        },
      });
      mockCommentRepo.findProjectMemberRole.mockResolvedValueOnce(
        'contributor',
      );

      await expect(
        service.deleteWorkItemComment('cmt-1', 'non-owner-user'),
      ).rejects.toThrow(ForbiddenException);

      mockCommentRepo.findProjectMemberRole.mockResolvedValueOnce('owner');
      const delRes = await service.deleteWorkItemComment('cmt-1', 'owner-user');
      expect(delRes.success).toBe(true);
    });

    it('should toggle emoji reactions and append replies on comments', async () => {
      mockCommentRepo.findCommentById.mockResolvedValue({
        id: 'cmt-1',
        reactions: { '👍': ['user-2'] },
        replies: [],
      });
      mockCommentRepo.updateComment.mockImplementation(
        (_id: string, data: any) => Promise.resolve({ id: 'cmt-1', ...data }),
      );

      // Add reaction from user-1
      const reactRes = await service.reactToWorkItemComment('cmt-1', 'user-1', {
        emoji: '👍',
      });
      expect((reactRes.comment.reactions as any)['👍']).toEqual([
        'user-2',
        'user-1',
      ]);

      // Add reply
      mockCommentRepo.findAuthorById.mockResolvedValue({
        id: 'user-1',
        name: 'User One',
        email: 'u1@example.com',
        avatar: null,
      });
      const replyRes = await service.addWorkItemReply('cmt-1', 'user-1', {
        content: 'LGTM!',
      });
      expect(replyRes.comment.replies).toHaveLength(1);
    });
  });

  // ── 7. HistoryService & Diff Util ──────────────────────────────────────────
  describe('HistoryService & summarizeDiff', () => {
    it('should format activity events and generate human-readable diff messages', async () => {
      const mockHistoryRepo = {
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
      };

      const historyService = new HistoryService(mockHistoryRepo as any);
      const res = await historyService.getActivity('wi-1', 'desc');

      expect(res.total).toBe(2);
      expect(res.activities[0].message).toBe(
        'Changed priority from "low" to "urgent"',
      );
      expect(res.activities[1].message).toBe('Alice created this item');
    });

    it('summarizeDiff should handle all work item fields cleanly', () => {
      expect(summarizeDiff('title', 'Old Title', 'New Title')).toBe(
        'Changed title from "Old Title" to "New Title"',
      );
      expect(summarizeDiff('description', 'abc', 'abcdef')).toBe(
        'Updated description (+3 chars)',
      );
      expect(summarizeDiff('state', 'To Do', 'Done')).toBe(
        'Changed state from "To Do" to "Done"',
      );
      expect(summarizeDiff('dueDate', null, '2026-12-01')).toBe(
        'Changed due date to 2026-12-01 (was (none))',
      );
      expect(summarizeDiff('story_points', '3', '5')).toBe(
        'Changed story points from 3 to 5',
      );
    });
  });

  // ── 8. CoreService & WorkItemFacade ────────────────────────────────────────
  describe('CoreService & WorkItemFacade', () => {
    it('CoreService.updateWorkItem should enforce optimistic concurrency control when expectedUpdatedAt is stale', async () => {
      const mockCoreRepo: any = {
        findWorkItemById: jest.fn().mockResolvedValue({
          id: 'wi-1',
          projectId: 'proj-1',
          updatedAt: new Date('2026-10-14T10:00:00Z'),
        }),
      };
      const coreService = new CoreService(
        mockCoreRepo,
        {} as any,
        {} as any,
        {} as any,
        { dispatchUpdateEvents: jest.fn() } as any,
      );

      await expect(
        coreService.updateWorkItem('wi-1', {
          title: 'Concurrent Edit',
          expectedUpdatedAt: '2026-10-14T09:55:00Z',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('WorkItemFacade should project WorkItemSummary and delegate cross-submodule calls cleanly', async () => {
      const now = new Date();
      const mockRepo: any = {
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
      };
      const facade = new WorkItemFacade(
        mockRepo,
        {
          getStateWorkItemCounts: jest.fn().mockResolvedValue({ 'col-1': 5 }),
        } as any,
        { getWorkItemsByLinkedEntity: jest.fn().mockResolvedValue([]) } as any,
        {
          getAssignees: jest
            .fn()
            .mockResolvedValue({ assignees: [{ id: 'u-2' }] }),
        } as any,
        {
          getWorkItemRelations: jest.fn().mockResolvedValue({ relations: [] }),
        } as any,
        {
          getActivity: jest
            .fn()
            .mockResolvedValue({ total: 0, activities: [] }),
        } as any,
      );

      const summary = await facade.getWorkItemById('FLUX-1');
      expect(summary?.identifier).toBe('FLUX-1');
      expect(await facade.countWorkItemsByProject('proj-1')).toBe(12);
      expect(await facade.getWorkItemAssignees('wi-1')).toEqual([
        { id: 'u-2' },
      ]);
    });
  });
});
