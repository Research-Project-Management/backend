import { Test, TestingModule } from '@nestjs/testing';
import { fromPartial } from '@total-typescript/shoehorn';
import { Prisma, TagType } from '@prisma/client';
import { NotesService } from '@/modules/library/reader/application/services/notes.service';
import { NotesRepository } from '@/modules/library/reader/infrastructure/repositories/notes.repository';
import { AnnotationsService } from '@/modules/library/reader/application/services/annotations.service';
import { AnnotationsRepository } from '@/modules/library/reader/infrastructure/repositories/annotations.repository';
import { TagsService } from '@/modules/library/bibliography/application/services/tags.service';
import { TagsRepository } from '@/modules/library/bibliography/infrastructure/repositories/tags.repository';
import { AttachmentsService } from '@/modules/library/reader/application/services/attachments.service';
import {
  TransactionService,
  TransactionHelpers,
} from '@/modules/library/shared-kernel/outbox/transaction.service';
import { PrismaService } from '@/core/database/prisma.service';
import { BIBLIOGRAPHY_FACADE } from '@/modules/library/bibliography/bibliography.facade';

describe('Library Sync & Multi-Tenant Changelog Scope Hardening', () => {
  const mockUserId = '11111111-1111-4111-8111-111111111111';
  const mockProjectId = '22222222-2222-4222-8222-222222222222';
  const mockItemId = '33333333-3333-4333-8333-333333333333';
  const mockAttachmentId = '44444444-4444-4444-8444-444444444444';
  const mockNoteId = '55555555-5555-4555-8555-555555555555';
  const mockAnnotationId = '66666666-6666-4666-8666-666666666666';
  const mockTagId = '77777777-7777-4777-8777-777777777777';

  let mockHelpers: jest.Mocked<TransactionHelpers>;
  let mockLibraryTx: { executeInTransaction: jest.Mock };

  beforeEach(() => {
    mockHelpers = {
      appendChange: jest.fn().mockResolvedValue(fromPartial({})),
      recordTombstone: jest.fn().mockResolvedValue(fromPartial({})),
      publishOutbox: jest.fn().mockResolvedValue(fromPartial({})),
    };

    mockLibraryTx = {
      executeInTransaction: jest
        .fn()
        .mockImplementation((cb: any) => cb({}, mockHelpers)),
    };
  });

  describe('NotesService Multi-Tenant Scoping', () => {
    let service: NotesService;
    let repo: jest.Mocked<NotesRepository>;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          NotesService,
          {
            provide: NotesRepository,
            useValue: {
              create: jest.fn(),
              update: jest.fn(),
              findById: jest.fn(),
              softDelete: jest.fn(),
              findMany: jest.fn(),
            },
          },
          { provide: TransactionService, useValue: mockLibraryTx },
          { provide: PrismaService, useValue: {} },
          {
            provide: BIBLIOGRAPHY_FACADE,
            useValue: {
              itemExists: jest.fn().mockResolvedValue(true),
              getItem: jest.fn().mockResolvedValue({
                id: mockItemId,
                projectId: mockProjectId,
              }),
            },
          },
        ],
      }).compile();

      service = module.get<NotesService>(NotesService);
      repo = module.get(NotesRepository);
    });

    it('should propagate projectId to appendChange and publishOutbox on createNote', async () => {
      repo.create.mockResolvedValue(
        fromPartial({
          id: mockNoteId,
          version: 1,
          title: 'Project Note',
          projectId: mockProjectId,
        }),
      );

      await service.createNote(mockUserId, {
        title: 'Project Note',
        projectId: mockProjectId,
        itemId: mockItemId,
        createdById: mockUserId,
      });

      expect(mockHelpers.appendChange).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({
          entityType: 'Note',
          entityId: mockNoteId,
          action: 'create',
        }),
      );

      expect(mockHelpers.publishOutbox).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        mockNoteId,
        'library.note.created',
        expect.anything(),
      );
    });

    it('should propagate projectId to appendChange and publishOutbox on updateNote', async () => {
      repo.update.mockResolvedValue(
        fromPartial({
          id: mockNoteId,
          version: 2,
          title: 'Updated Note',
          projectId: mockProjectId,
        }),
      );

      await service.updateNote(
        mockUserId,
        mockNoteId,
        1,
        { title: 'Updated Note' },
        mockProjectId,
      );

      expect(mockHelpers.appendChange).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({
          entityType: 'Note',
          entityId: mockNoteId,
          action: 'update',
          version: 2,
        }),
      );

      expect(mockHelpers.publishOutbox).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        mockNoteId,
        'library.note.updated',
        expect.anything(),
      );
    });

    it('should propagate projectId to recordTombstone and publishOutbox on deleteNote', async () => {
      repo.findById.mockResolvedValue(
        fromPartial({
          id: mockNoteId,
          projectId: mockProjectId,
        }),
      );
      repo.softDelete.mockResolvedValue(true);

      await service.deleteNote(mockUserId, mockNoteId, 1, mockProjectId);

      expect(mockHelpers.recordTombstone).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({
          entityType: 'Note',
          entityId: mockNoteId,
        }),
      );

      expect(mockHelpers.publishOutbox).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        mockNoteId,
        'library.note.deleted',
        expect.anything(),
      );
    });

    it('should pass projectId syncScope to appendChange in upsertFromSync', async () => {
      const mockTx = fromPartial<Prisma.TransactionClient>({
        note: {
          findUnique: jest.fn().mockResolvedValue({
            id: mockNoteId,
            userId: mockUserId,
            projectId: mockProjectId,
            tags: [],
          }),
          update: jest.fn().mockResolvedValue({
            id: mockNoteId,
            version: 3,
            projectId: mockProjectId,
          }),
        },
      });

      await service.upsertFromSync(
        {
          userId: mockUserId,
          projectId: mockProjectId,
          existingId: mockNoteId,
          title: 'Synced Note',
          contentMd: 'Synced content',
        },
        mockTx,
        mockHelpers,
      );

      expect(mockHelpers.appendChange).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({
          entityType: 'Note',
          entityId: mockNoteId,
          action: 'update',
          version: 3,
        }),
      );
    });

    it('should record tombstone with projectId in deleteFromSync', async () => {
      const mockTx = fromPartial<Prisma.TransactionClient>({
        note: {
          findFirst: jest.fn().mockResolvedValue({
            id: mockNoteId,
            version: 1,
            projectId: mockProjectId,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });

      await service.deleteFromSync(
        {
          userId: mockUserId,
          projectId: mockProjectId,
          entityId: mockNoteId,
          entityType: 'Note',
        },
        mockTx,
        mockHelpers,
      );

      expect(mockHelpers.appendChange).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({
          entityType: 'Note',
          entityId: mockNoteId,
          action: 'delete',
        }),
      );

      expect(mockHelpers.recordTombstone).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({
          entityType: 'Note',
          entityId: mockNoteId,
        }),
      );
    });
  });

  describe('AnnotationsService Multi-Tenant Scoping', () => {
    let service: AnnotationsService;
    let repo: jest.Mocked<AnnotationsRepository>;
    let attachmentsService: jest.Mocked<AttachmentsService>;

    beforeEach(async () => {
      attachmentsService = fromPartial({
        assertAttachmentExists: jest.fn().mockResolvedValue({
          id: mockAttachmentId,
          item: { id: mockItemId, projectId: mockProjectId },
        }),
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AnnotationsService,
          {
            provide: AnnotationsRepository,
            useValue: {
              create: jest.fn(),
              update: jest.fn(),
              findById: jest.fn(),
              softDelete: jest.fn(),
              findByAttachment: jest.fn(),
            },
          },
          { provide: TransactionService, useValue: mockLibraryTx },
          { provide: AttachmentsService, useValue: attachmentsService },
        ],
      }).compile();

      service = module.get<AnnotationsService>(AnnotationsService);
      repo = module.get(AnnotationsRepository);
    });

    it('should inherit projectId from parent item on createAnnotation', async () => {
      repo.create.mockResolvedValue(
        fromPartial({
          id: mockAnnotationId,
          version: 1,
        }),
      );

      await service.createAnnotation(mockUserId, {
        authorId: mockUserId,
        attachmentId: mockAttachmentId,
        pageIndex: 1,
        quoteText: 'Deep neural networks learn representations',
      });

      expect(mockHelpers.appendChange).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({
          entityType: 'Annotation',
          entityId: mockAnnotationId,
          action: 'create',
        }),
      );

      expect(mockHelpers.publishOutbox).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        mockAnnotationId,
        'library.annotation.created',
        expect.anything(),
      );
    });

    it('should inherit projectId on deleteAnnotation and record tombstone', async () => {
      repo.findById.mockResolvedValue(
        fromPartial({
          id: mockAnnotationId,
          attachmentId: mockAttachmentId,
          authorId: mockUserId,
        }),
      );
      repo.softDelete.mockResolvedValue(true);

      await service.deleteAnnotation(mockUserId, mockAnnotationId);

      expect(mockHelpers.recordTombstone).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({
          entityType: 'Annotation',
          entityId: mockAnnotationId,
        }),
      );

      expect(mockHelpers.publishOutbox).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        mockAnnotationId,
        'library.annotation.deleted',
        expect.anything(),
      );
    });

    it('should record tombstone and appendChange with syncScope on deleteFromSync', async () => {
      const mockTx = fromPartial<Prisma.TransactionClient>({
        annotation: {
          findUnique: jest.fn().mockResolvedValue({
            id: mockAnnotationId,
            attachmentId: mockAttachmentId,
            version: 1,
          }),
          update: jest.fn().mockResolvedValue({}),
        },
      });

      await service.deleteFromSync(
        {
          userId: mockUserId,
          projectId: mockProjectId,
          entityId: mockAnnotationId,
          entityType: 'Annotation',
        },
        mockTx,
        mockHelpers,
      );

      expect(mockHelpers.appendChange).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({
          entityType: 'Annotation',
          entityId: mockAnnotationId,
          action: 'delete',
        }),
      );

      expect(mockHelpers.recordTombstone).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({
          entityType: 'Annotation',
          entityId: mockAnnotationId,
        }),
      );
    });
  });

  describe('TagsService Multi-Tenant Scoping', () => {
    let service: TagsService;
    let repo: jest.Mocked<TagsRepository>;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          TagsService,
          {
            provide: TagsRepository,
            useValue: {
              create: jest.fn(),
              delete: jest.fn(),
              assignToItem: jest.fn(),
              removeFromItem: jest.fn(),
              findUnique: jest.fn(),
            },
          },
          { provide: TransactionService, useValue: mockLibraryTx },
          { provide: PrismaService, useValue: {} },
        ],
      }).compile();

      service = module.get<TagsService>(TagsService);
      repo = module.get(TagsRepository);
      jest.spyOn(service, 'invalidateTagsCache').mockResolvedValue(undefined);
    });

    it('should propagate projectId on createOrGetTag', async () => {
      repo.create.mockResolvedValue(
        fromPartial({
          id: mockTagId,
          name: 'physics',
          projectId: mockProjectId,
        }),
      );

      await service.createOrGetTag(
        mockUserId,
        'physics',
        '#00ff00',
        TagType.manual,
        mockProjectId,
      );

      expect(mockHelpers.appendChange).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({
          entityType: 'Tag',
          entityId: mockTagId,
          action: 'create',
        }),
      );

      expect(mockHelpers.publishOutbox).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        mockTagId,
        'library.tag.created',
        expect.anything(),
      );
    });

    it('should propagate projectId on assignTag and removeTag', async () => {
      const mockTx = {
        tag: { findFirst: jest.fn().mockResolvedValue({ id: mockTagId }) },
        item: { findFirst: jest.fn().mockResolvedValue({ id: mockItemId }) },
      };
      mockLibraryTx.executeInTransaction.mockImplementation((cb: any) =>
        cb(mockTx, mockHelpers),
      );

      await service.assignTag(mockUserId, mockTagId, mockItemId, mockProjectId);

      expect(mockHelpers.appendChange).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({
          entityType: 'ItemTag',
          entityId: `${mockTagId}:${mockItemId}`,
          action: 'create',
        }),
      );

      await service.removeTag(mockUserId, mockTagId, mockItemId, mockProjectId);

      expect(mockHelpers.recordTombstone).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({
          entityType: 'ItemTag',
          entityId: `${mockTagId}:${mockItemId}`,
        }),
      );
    });
  });
});
