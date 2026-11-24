import { NotFoundException } from '@nestjs/common';
import { fromPartial } from '@total-typescript/shoehorn';
import type { PrismaService } from '@/core';
import { AccessRepository } from '@/modules/ai/access/access.repository';
import { AccessService } from '@/modules/ai/access/services/access.service';
import { DocumentAccessService } from '@/modules/ai/access/services/document.service';
import { SpaceAccessService } from '@/modules/ai/access/services/space.service';
import { ChatRepository } from '@/modules/ai/chat/chat.repository';
import { SessionController } from '@/modules/ai/chat/controllers/session.controller';
import { ChatService } from '@/modules/ai/chat/services/chat.service';
import { SessionService } from '@/modules/ai/chat/services/session.service';
import { TitleService } from '@/modules/ai/chat/services/title.service';
import type { IAiEnginePort } from '@/modules/ai/engine/engine.port';

describe('AI Module Deepening: Batched Document Resolution & SQL Pagination', () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  const chatId = '22222222-2222-2222-2222-222222222222';

  describe('DocumentAccessService.resolveChatDocuments & ChatService batched turn lookup', () => {
    it('queries libraryItem and fileNode once per chat turn when both documentIds and attached_sources are present', async () => {
      const fileNodeFindMany = jest.fn().mockImplementation(async (args?: { where?: { id?: { in?: string[] } } }) => {
        const ids = args?.where?.id?.in ?? [];
        const rows: Array<{ id: string; metadata: unknown }> = [];
        if (ids.includes('file-direct-1')) {
          rows.push({ id: 'file-direct-1', metadata: { ragDocId: 'rag-direct-1' } });
        }
        if (ids.includes('file-att-2')) {
          rows.push({ id: 'file-att-2', metadata: { ragDocId: 'rag-att-2' } });
        }
        return rows;
      });

      const libraryItemFindMany = jest.fn().mockResolvedValue([
        {
          id: 'item-1',
          title: 'Attention Is All You Need',
          metadata: { ragDocId: 'rag-item-1' },
          attachments: [
            {
              fileId: 'file-att-1',
              attachmentType: 'primary_pdf',
              metadata: null,
            },
          ],
        },
        {
          id: 'item-2',
          title: 'Deep Residual Learning',
          metadata: null,
          attachments: [
            {
              fileId: 'file-att-2',
              attachmentType: 'primary_pdf',
              metadata: null,
            },
          ],
        },
      ]);

      const existingChat = {
        id: chatId,
        createdById: userId,
        spaceId: userId,
        title: 'Research Chat',
        documentIds: [],
        messages: [],
        space: { projectId: null },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockPrisma = fromPartial<PrismaService>({
        space: { findFirst: jest.fn().mockResolvedValue(null) },
        project: { findFirst: jest.fn().mockResolvedValue(null) },
        page: { findFirst: jest.fn().mockResolvedValue(null) },
        pageDoc: { findFirst: jest.fn().mockResolvedValue(null) },
        fileNode: {
          findMany: fileNodeFindMany,
          findFirst: jest.fn().mockResolvedValue(null),
        },
        libraryItem: {
          findMany: libraryItemFindMany,
        },
        aiChat: {
          findFirst: jest.fn().mockResolvedValue(existingChat),
          findUnique: jest.fn().mockResolvedValue(existingChat),
          update: jest.fn().mockResolvedValue(existingChat),
        },
        aiMessage: {
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });

      const accessRepo = new AccessRepository(mockPrisma);
      const spaceAccess = new SpaceAccessService(accessRepo);
      const documentAccess = new DocumentAccessService(accessRepo, spaceAccess);
      const accessService = new AccessService(spaceAccess, documentAccess, accessRepo);
      const chatRepo = new ChatRepository(mockPrisma);
      const sessionService = new SessionService(chatRepo, spaceAccess);
      const titleService = new TitleService(chatRepo);

      const chatSync = jest.fn().mockResolvedValue({
        content: 'Synthesized answer',
        route: 'rag_agent',
        status: 'completed',
        citations: [],
        sources: [],
        interrupts: [],
        usage: {},
        trace_id: 'trace-batch-1',
      });
      const mockEngine = fromPartial<IAiEnginePort>({ chatSync });
      const chatService = new ChatService(
        mockEngine,
        accessService,
        sessionService,
        titleService,
      );

      await chatService.execute(userId, {
        chatId,
        query: 'Compare these papers',
        documentIds: ['file-direct-1', 'item-1'],
        context: {
          attached_sources: [
            { kind: 'paper', item_id: 'item-1' },
            { kind: 'library', item_id: 'item-2' },
          ],
        },
      });

      // Core invariant: libraryItem.findMany is queried ONCE for the union of all candidate IDs
      expect(libraryItemFindMany).toHaveBeenCalledTimes(1);
      const queriedItemIds = (
        libraryItemFindMany.mock.calls[0]?.[0] as { where: { id: { in: string[] } } }
      ).where.id.in;
      expect(queriedItemIds).toEqual(expect.arrayContaining(['item-1', 'item-2']));
      expect(queriedItemIds).not.toContain('file-direct-1');

      // fileNode.findMany is called once for direct documentIds and once for unresolved attachment file-att-2 (never duplicated)
      expect(fileNodeFindMany).toHaveBeenCalledTimes(2);
      expect(
        (fileNodeFindMany.mock.calls[1]?.[0] as { where: { id: { in: string[] } } }).where.id.in,
      ).toEqual(['file-att-2']);

      // Engine request receives both resolved document IDs and enriched attached_sources
      const sentRequest = chatSync.mock.calls[0]?.[0];
      expect(sentRequest.document_ids).toEqual(
        expect.arrayContaining(['rag-direct-1', 'rag-item-1', 'rag-att-2']),
      );
      expect(sentRequest.context?.attached_sources).toEqual([
        {
          kind: 'paper',
          title: 'Attention Is All You Need',
          source_id: 'rag-item-1',
          source_type: 'file',
          item_id: 'item-1',
          file_id: 'file-att-1',
          has_pdf: true,
          indexed: true,
        },
        {
          kind: 'library',
          title: 'Deep Residual Learning',
          source_id: 'rag-att-2',
          source_type: 'file',
          item_id: 'item-2',
          file_id: 'file-att-2',
          has_pdf: true,
          indexed: true,
        },
      ]);
    });

    it('makes zero DB queries when documentIds and attached_sources are both empty', async () => {
      const fileNodeFindMany = jest.fn();
      const libraryItemFindMany = jest.fn();
      const mockPrisma = fromPartial<PrismaService>({
        fileNode: { findMany: fileNodeFindMany },
        libraryItem: { findMany: libraryItemFindMany },
      });

      const accessRepo = new AccessRepository(mockPrisma);
      const spaceAccess = new SpaceAccessService(accessRepo);
      const documentAccess = new DocumentAccessService(accessRepo, spaceAccess);

      const result = await documentAccess.resolveChatDocuments([], undefined);
      expect(result).toEqual({
        resolvedDocumentIds: [],
        enrichedSources: [],
      });
      expect(fileNodeFindMany).not.toHaveBeenCalled();
      expect(libraryItemFindMany).not.toHaveBeenCalled();
    });
  });

  describe('SessionService.getChatMessages & SessionController SQL pagination', () => {
    it('paginates messages via Prisma skip/take + count after lightweight ownership check', async () => {
      const chatFindFirst = jest.fn().mockResolvedValue({ id: chatId });
      const msgCreatedAt = new Date('2026-03-01T10:00:00.000Z');
      const aiMessageFindMany = jest.fn().mockResolvedValue([
        {
          id: 'msg-3',
          chatId,
          role: 'user',
          content: 'Question 2',
          sources: [{ title: 'Paper A' }],
          widgets: [],
          createdAt: msgCreatedAt,
        },
        {
          id: 'msg-4',
          chatId,
          role: 'assistant',
          content: 'Answer 2',
          sources: [{ source: 'doc-1', title: 'Paper A' }],
          widgets: [],
          createdAt: msgCreatedAt,
        },
      ]);
      const aiMessageCount = jest.fn().mockResolvedValue(42);

      const mockPrisma = fromPartial<PrismaService>({
        aiChat: { findFirst: chatFindFirst },
        aiMessage: {
          findMany: aiMessageFindMany,
          count: aiMessageCount,
        },
      });

      const accessRepo = new AccessRepository(mockPrisma);
      const spaceAccess = new SpaceAccessService(accessRepo);
      const chatRepo = new ChatRepository(mockPrisma);
      const sessionService = new SessionService(chatRepo, spaceAccess);
      const controller = new SessionController(sessionService);

      const result = await controller.getChatMessages(chatId, userId, 20, 10);

      // Lightweight ownership check: selects only id, does NOT include messages
      expect(chatFindFirst).toHaveBeenCalledTimes(1);
      expect(chatFindFirst).toHaveBeenCalledWith({
        where: { id: chatId, createdById: userId },
        select: { id: true },
      });

      // SQL pagination via Prisma skip/take + count
      expect(aiMessageFindMany).toHaveBeenCalledWith({
        where: { chatId },
        orderBy: { createdAt: 'asc' },
        skip: 10,
        take: 20,
      });
      expect(aiMessageCount).toHaveBeenCalledWith({
        where: { chatId },
      });

      expect(result).toEqual({
        total: 42,
        messages: [
          {
            id: 'msg-3',
            role: 'user',
            content: 'Question 2',
            sources: undefined,
            attachments: [{ title: 'Paper A' }],
            widgets: [],
            createdAt: '2026-03-01T10:00:00.000Z',
          },
          {
            id: 'msg-4',
            role: 'assistant',
            content: 'Answer 2',
            sources: [{ source: 'doc-1', title: 'Paper A' }],
            attachments: undefined,
            widgets: [],
            createdAt: '2026-03-01T10:00:00.000Z',
          },
        ],
      });
    });

    it('clamps limit to [1, 200] (default 50) and skip to >= 0', async () => {
      const aiMessageFindMany = jest.fn().mockResolvedValue([]);
      const aiMessageCount = jest.fn().mockResolvedValue(0);
      const mockPrisma = fromPartial<PrismaService>({
        aiChat: { findFirst: jest.fn().mockResolvedValue({ id: chatId }) },
        aiMessage: {
          findMany: aiMessageFindMany,
          count: aiMessageCount,
        },
      });

      const sessionService = new SessionService(
        new ChatRepository(mockPrisma),
        new SpaceAccessService(new AccessRepository(mockPrisma)),
      );

      await sessionService.getChatMessages(chatId, userId, {
        limit: 999,
        skip: -5,
      });
      expect(aiMessageFindMany).toHaveBeenLastCalledWith({
        where: { chatId },
        orderBy: { createdAt: 'asc' },
        skip: 0,
        take: 200,
      });

      await sessionService.getChatMessages(chatId, userId);
      expect(aiMessageFindMany).toHaveBeenLastCalledWith({
        where: { chatId },
        orderBy: { createdAt: 'asc' },
        skip: 0,
        take: 50,
      });
    });

    it('throws NotFoundException and skips message queries when chat is not owned by user', async () => {
      const aiMessageFindMany = jest.fn();
      const aiMessageCount = jest.fn();
      const mockPrisma = fromPartial<PrismaService>({
        aiChat: { findFirst: jest.fn().mockResolvedValue(null) },
        aiMessage: {
          findMany: aiMessageFindMany,
          count: aiMessageCount,
        },
      });

      const sessionService = new SessionService(
        new ChatRepository(mockPrisma),
        new SpaceAccessService(new AccessRepository(mockPrisma)),
      );

      await expect(
        sessionService.getChatMessages(chatId, userId, { limit: 10, skip: 0 }),
      ).rejects.toThrow(NotFoundException);
      expect(aiMessageFindMany).not.toHaveBeenCalled();
      expect(aiMessageCount).not.toHaveBeenCalled();
    });
  });

  describe('SessionService.createChat single space resolution', () => {
    it('does not call resolveSpace before resolvePageScope when pageId is provided', async () => {
      const pageId = '44444444-4444-4444-4444-444444444444';
      const spaceId = '55555555-5555-5555-5555-555555555555';

      const mockPrisma = fromPartial<PrismaService>({
        space: {
          findFirst: jest.fn().mockResolvedValue({
            id: spaceId,
            type: 'personal',
            ownerUserId: userId,
            projectId: null,
          }),
        },
        project: { findFirst: jest.fn().mockResolvedValue(null) },
        page: {
          findFirst: jest.fn().mockResolvedValue({
            id: pageId,
            title: 'Manuscript',
            spaceId,
          }),
        },
        pageDoc: { findFirst: jest.fn().mockResolvedValue(null) },
        aiChat: {
          create: jest.fn().mockResolvedValue({
            id: chatId,
            createdById: userId,
            spaceId,
            pageId,
            title: 'Manuscript Chat',
            documentIds: [],
            messages: [],
            space: { projectId: null },
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
      });

      const spaceAccess = new SpaceAccessService(new AccessRepository(mockPrisma));
      const resolveSpaceSpy = jest.spyOn(spaceAccess, 'resolveSpace');
      const resolvePageScopeSpy = jest.spyOn(spaceAccess, 'resolvePageScope');
      const sessionService = new SessionService(
        new ChatRepository(mockPrisma),
        spaceAccess,
      );

      await sessionService.createChat(userId, {
        pageId,
        spaceId: 'personal',
        title: 'Manuscript Chat',
      });

      expect(resolvePageScopeSpy).toHaveBeenCalledTimes(1);
      // resolveSpace is called once inside resolvePageScope, never twice
      expect(resolveSpaceSpy).toHaveBeenCalledTimes(1);
    });
  });
});
