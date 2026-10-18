/**
 * test/unit/manuscripts-realtime.service.spec.ts
 *
 * Comprehensive Unit Test Suite for Manuscripts Real-Time Collaboration Subsystem
 * (Modular Monolith Architecture).
 */

import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import { CoreService } from '@/modules/realtime/core/core.service';
import { ManuscriptsGateway } from '@/modules/realtime/manuscripts/manuscripts.gateway';
import { ManuscriptsService } from '@/modules/realtime/manuscripts/manuscripts.service';
import { RoomStore } from '@/modules/realtime/manuscripts/room.store';
import { ChatService } from '@/modules/realtime/manuscripts/chat.service';
import { WsAuthService } from '@/modules/realtime/core/ws-auth.guard';
import { REALTIME_EVENTS } from '@/modules/realtime/core/realtime.constant';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Unit Test Suite
// ---------------------------------------------------------------------------

describe('Manuscripts Real-Time Collaboration Subsystem (Modular Monolith)', () => {
  const projectId = '01928374-beef-4000-8000-000000000001';
  const docId = '01928374-beef-4000-8000-000000000002';
  const user1 = '01928374-beef-4000-8000-000000000010';
  const user2 = '01928374-beef-4000-8000-000000000020';

  let roomStore: RoomStore;
  let manuscriptsService: ManuscriptsService;
  let chatService: ChatService;
  let authService: WsAuthService;
  let gateway: ManuscriptsGateway;
  let realtimeFacade: RealtimeFacade;

  // Mock Socket.IO server
  let mockServer: any;
  let emittedEvents: Array<{ room?: string; event: string; payload: any; except?: string }> = [];

  beforeEach(() => {
    emittedEvents = [];
    mockServer = {
      to: (room: string) => ({
        emit: (event: string, payload: any) => {
          emittedEvents.push({ room, event, payload });
        },
        except: (exceptSocketId: string) => ({
          emit: (event: string, payload: any) => {
            emittedEvents.push({ room, event, payload, except: exceptSocketId });
          },
        }),
      }),
      emit: (event: string, payload: any) => {
        emittedEvents.push({ event, payload });
      },
      sockets: {
        adapter: {
          rooms: new Map(),
        },
      },
    };

    roomStore = new RoomStore(); // in-memory fallback mode
    chatService = new ChatService();
    authService = new WsAuthService();

    // ManuscriptsService with mock Prisma/DocUpdater (fallback mode)
    manuscriptsService = new ManuscriptsService(roomStore);

    gateway = new ManuscriptsGateway(
      manuscriptsService,
      chatService,
      authService,
    );
    gateway.server = mockServer;

    const coreService = new CoreService();
    realtimeFacade = new RealtimeFacade(
      roomStore,
      coreService,
      undefined,
      gateway,
    );
  });

  // =========================================================================
  // 1. RoomStore
  // =========================================================================
  describe('1. RoomStore (Session & Presence State)', () => {
    it('manages project sessions and deterministic color palette', async () => {
      const color1 = roomStore.getDeterministicColor(user1);
      const color2 = roomStore.getDeterministicColor(user1);
      expect(color1).toBe(color2);
      expect(color1).toMatch(/^#[0-9a-f]{6}$/i);

      await roomStore.addProjectSession({
        userId: user1,
        socketId: 'sock-1',
        projectId,
        name: 'Dr. Alice',
        lastHeartbeat: Date.now(),
      });

      const sessions = await roomStore.getProjectSessions(projectId);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].name).toBe('Dr. Alice');
      expect(sessions[0].color).toBe(color1);
      expect(roomStore.getSession('sock-1')?.userId).toBe(user1);
    });

    it('manages document room membership and cursor positioning', async () => {
      await roomStore.addProjectSession({
        userId: user1,
        socketId: 'sock-1',
        projectId,
        name: 'Alice',
        lastHeartbeat: Date.now(),
      });

      const docSessions = await roomStore.joinDocRoom(projectId, docId, 'sock-1');
      expect(docSessions).toHaveLength(1);
      expect(docSessions[0].activeDocId).toBe(docId);

      // Update cursor with coordinate clamping
      const updated = await roomStore.updateSessionCursor(projectId, docId, 'sock-1', {
        row: -5,
        column: 14.6,
        selection: {
          anchor: { row: -1, column: 2 },
          head: { row: 3, column: 8 },
        },
      });

      expect(updated?.cursor?.row).toBe(0);
      expect(updated?.cursor?.column).toBe(14);
      expect(updated?.cursor?.selection?.anchor.row).toBe(0);

      // Leave doc room
      await roomStore.leaveDocRoom(projectId, docId, 'sock-1');
      const docSessionsAfter = await roomStore.getDocSessions(projectId, docId);
      expect(docSessionsAfter).toHaveLength(0);

      // Remove project session
      const removed = await roomStore.removeProjectSession(projectId, 'sock-1');
      expect(removed?.userId).toBe(user1);
      expect(await roomStore.getProjectSessions(projectId)).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2. ManuscriptsService
  // =========================================================================
  describe('2. ManuscriptsService (Collaboration Logic)', () => {
    it('joinProject: registers presence and returns project active users', async () => {
      const res = await manuscriptsService.joinProject({
        projectId,
        userId: user1,
        socketId: 'sock-1',
        name: 'Prof. Turing',
      });

      expect(res.session.userId).toBe(user1);
      expect(res.projectPresence).toHaveLength(1);
      expect(res.access.canRead).toBe(true);
    });

    it('joinDoc & leaveDoc: manages active document presence', async () => {
      await manuscriptsService.joinProject({
        projectId,
        userId: user1,
        socketId: 'sock-1',
      });

      const joinRes = await manuscriptsService.joinDoc(projectId, docId, 'sock-1');
      expect(joinRes.docPresence).toHaveLength(1);

      await manuscriptsService.leaveDoc(projectId, docId, 'sock-1');
      expect(await manuscriptsService.getDocPresence(projectId, docId)).toHaveLength(0);
    });

    it('joinDoc: throws NotFoundException if session does not exist', async () => {
      await expect(
        manuscriptsService.joinDoc(projectId, docId, 'non-existent-sock'),
      ).rejects.toThrow(NotFoundException);
    });

    it('applyDocUpdate: advances rev and returns ACK details', async () => {
      const result = await manuscriptsService.applyDocUpdate(
        {
          projectId,
          docId,
          clientRev: 3,
          lines: ['\\section{Intro}', 'Realtime content'],
        },
        user1,
      );

      expect(result.clientRev).toBe(3);
      expect(result.serverRev).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 3. ChatService
  // =========================================================================
  describe('3. ChatService', () => {
    it('saves messages and retrieves project chat history', () => {
      chatService.saveMessage(
        { projectId, text: 'Hello team!' },
        { id: user1, name: 'Alice', color: '#3B82F6' },
      );

      const history = chatService.getHistory(projectId);
      expect(history).toHaveLength(1);
      expect(history[0].text).toBe('Hello team!');
      expect(history[0].userName).toBe('Alice');
    });
  });

  // =========================================================================
  // 4. RealtimeFacade & RealtimeController (Unified Flow)
  // =========================================================================
  describe('4. RealtimeFacade & RealtimeController (Unified Flow)', () => {
    it('broadcasts file tree mutations to project peers', () => {
      realtimeFacade.broadcastFileTreeChange(projectId, {
        action: 'create',
        node: { id: 'n-1', path: '/intro.tex' },
      });

      expect(emittedEvents.some((e) => e.event === REALTIME_EVENTS.FILE_TREE_UPDATE)).toBe(true);
    });

    it('broadcasts LaTeX compilation progress', () => {
      realtimeFacade.broadcastCompileProgress(projectId, {
        status: 'success',
        pdfUrl: '/api/pdf',
      });

      expect(emittedEvents.some((e) => e.event === REALTIME_EVENTS.COMPILE_PROGRESS)).toBe(true);
    });

    it('broadcasts snapshot creation', () => {
      realtimeFacade.broadcastSnapshotCreated(projectId, {
        version: 2,
        label: 'v1.0',
      });

      expect(emittedEvents.some((e) => e.event === REALTIME_EVENTS.HISTORY_NEW_VERSION)).toBe(true);
    });

    it('provides unified access to stats, presence, and flush barrier', async () => {
      const stats = realtimeFacade.getStats();
      expect(stats.status).toBe('ok');

      const projectPresence = await realtimeFacade.getProjectPresence(projectId);
      expect(Array.isArray(projectPresence)).toBe(true);

      const docPresence = await realtimeFacade.getDocPresence(projectId, docId);
      expect(Array.isArray(docPresence)).toBe(true);

      const flushedCount = await realtimeFacade.flushProjectBeforeCompile(projectId);
      expect(flushedCount).toBe(0);
    });
  });

  // =========================================================================
  // 5. ManuscriptsGateway Integration
  // =========================================================================
  describe('5. ManuscriptsGateway', () => {
    it('handleConnection: assigns anonymous metadata if no token', async () => {
      const mockSocket: any = {
        id: 'sock-anon-999',
        handshake: { headers: {}, auth: {}, query: {} },
        data: {},
      };

      await gateway.handleConnection(mockSocket);
      expect(mockSocket.data.userId).toMatch(/^anon-/);
      expect(mockSocket.data.name).toBe('Collaborator');
    });

    it('handles project join, doc join, update, cursor, and leave lifecycle', async () => {
      const joinedRooms = new Set<string>();
      const sentEvents: Array<{ event: string; payload: any }> = [];

      const mockSocket: any = {
        id: 'sock-alice',
        handshake: { headers: {}, auth: { userId: user1, name: 'Alice' }, query: {} },
        data: { userId: user1, name: 'Alice' },
        join: (r: string) => joinedRooms.add(r),
        leave: (r: string) => joinedRooms.delete(r),
        emit: (ev: string, data: any) => sentEvents.push({ event: ev, payload: data }),
      };

      // 1. Join project
      const joinProj = await gateway.handleJoinProject(mockSocket, { projectId });
      expect(joinProj.success).toBe(true);
      expect(joinedRooms.has(`project:${projectId}`)).toBe(true);
      expect(emittedEvents.some((e) => e.event === REALTIME_EVENTS.USER_JOINED_PROJECT)).toBe(true);

      // 2. Join doc
      const joinDoc = await gateway.handleJoinDoc(mockSocket, { projectId, docId });
      expect(joinDoc.success).toBe(true);
      expect(joinedRooms.has(`doc:${projectId}:${docId}`)).toBe(true);

      // 3. Send doc update
      const updateRes = await gateway.handleDocUpdate(mockSocket, {
        projectId,
        docId,
        clientRev: 1,
        lines: ['Live line'],
      });
      expect(updateRes.success).toBe(true);
      expect(sentEvents.some((e) => e.event === REALTIME_EVENTS.DOC_UPDATE_ACK)).toBe(true);
      expect(emittedEvents.some((e) => e.event === REALTIME_EVENTS.DOC_UPDATE)).toBe(true);

      // 4. Update cursor
      const cursorRes = await gateway.handleCursorUpdate(mockSocket, {
        projectId,
        docId,
        cursor: { row: 2, column: 5 },
      });
      expect(cursorRes.success).toBe(true);
      expect(emittedEvents.some((e) => e.event === REALTIME_EVENTS.DOC_CURSOR)).toBe(true);

      // 5. Chat message
      const chatRes = gateway.handleChatSend(mockSocket, {
        projectId,
        text: 'Review looks good!',
      });
      expect(chatRes.success).toBe(true);
      expect(emittedEvents.some((e) => e.event === REALTIME_EVENTS.CHAT_NEW)).toBe(true);

      // 6. Leave doc
      const leaveDoc = await gateway.handleLeaveDoc(mockSocket, { projectId, docId });
      expect(leaveDoc.success).toBe(true);
      expect(joinedRooms.has(`doc:${projectId}:${docId}`)).toBe(false);

      // 7. Leave project
      const leaveProj = await gateway.handleLeaveProject(mockSocket, { projectId });
      expect(leaveProj.success).toBe(true);
      expect(joinedRooms.has(`project:${projectId}`)).toBe(false);
    });

    it('handleDisconnect: cleans up doc and project presence', async () => {
      const mockSocket: any = {
        id: 'sock-disc',
        handshake: { headers: {}, auth: { userId: user1 }, query: {} },
        data: { projectId, activeDocId: docId, userId: user1 },
      };

      await manuscriptsService.joinProject({
        projectId,
        userId: user1,
        socketId: 'sock-disc',
      });
      await manuscriptsService.joinDoc(projectId, docId, 'sock-disc');

      await gateway.handleDisconnect(mockSocket);

      expect(await roomStore.getDocSessions(projectId, docId)).toHaveLength(0);
      expect(await roomStore.getProjectSessions(projectId)).toHaveLength(0);
    });
  });
});
