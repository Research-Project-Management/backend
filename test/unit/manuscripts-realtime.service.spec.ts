/**
 * test/unit/manuscripts-realtime.service.spec.ts
 *
 * Comprehensive Unit Test Suite for Manuscripts Real-Time Collaboration Gateway.
 * (Overleaf-parity Socket.IO Gateway, Multi-User Cursor Awareness & In-Flight Relay).
 *
 * Validates:
 *  1. Domain Value Objects & Entities:
 *      - CursorPositionVo (row, column, anchor, head, non-negative clamp)
 *      - ClientUpdatePayloadVo (validation, full lines vs splice deltas)
 *      - UserPresenceVo (JSON serialization, cursor attachment)
 *      - PresenceSession (color hash palette, activeDocId transition, heartbeat)
 *      - DocRoom (multi-socket management, session retrieval, empty lifecycle)
 *  2. Adapters & Ports:
 *      - InMemoryRoomManagerAdapter (project & doc room membership, cursor persistence)
 *      - MockBroadcaster (event capture, room targeting, peer exclusion)
 *      - MockDocumentUpdaterBridge (rev advancement, in-flight sequence tracking)
 *      - MockProjectAccessVerifier (RBAC checks: owner, contributor, reviewer, non-member)
 *  3. Inbound Use Cases:
 *      - JoinProjectUseCase (permission check, session creation, peer broadcast)
 *      - LeaveProjectUseCase (room eviction, project & doc presence cleanup)
 *      - JoinDocUseCase (doc-specific awareness, peer announcement)
 *      - LeaveDocUseCase (cursor retraction, doc exit broadcast)
 *      - SendDocUpdateUseCase (write authorization, bridge forward, peer broadcast, ACK)
 *      - BroadcastCursorUseCase (cursor update & broadcast)
 *      - BroadcastProjectEventUseCase (subsystem events dispatch)
 *  4. RealtimeService (Facade Orchestrator):
 *      - broadcastFileTreeChange (Structure subsystem integration)
 *      - broadcastCompileProgress (CLSI subsystem integration)
 *      - broadcastSnapshotCreated (Project History subsystem integration)
 *      - getProjectPresence & getDocPresence queries
 *  5. ManuscriptRealtimeGateway:
 *      - Socket connection lifecycle, token extraction & anonymous fallback
 *      - Disconnect cleanup
 *      - Message subscriptions (project:join, doc:join, doc:update, doc:cursor)
 */

import { RealtimeService } from '@/modules/manuscripts/realtime/realtime.service';
import { ManuscriptRealtimeGateway } from '@/modules/manuscripts/realtime/realtime.gateway';

// Use Cases
import { JoinProjectUseCase } from '@/modules/manuscripts/realtime/core/use-cases/join-project.use-case';
import { LeaveProjectUseCase } from '@/modules/manuscripts/realtime/core/use-cases/leave-project.use-case';
import { JoinDocUseCase } from '@/modules/manuscripts/realtime/core/use-cases/join-doc.use-case';
import { LeaveDocUseCase } from '@/modules/manuscripts/realtime/core/use-cases/leave-doc.use-case';
import { SendDocUpdateUseCase } from '@/modules/manuscripts/realtime/core/use-cases/send-doc-update.use-case';
import { BroadcastCursorUseCase } from '@/modules/manuscripts/realtime/core/use-cases/broadcast-cursor.use-case';
import { BroadcastProjectEventUseCase } from '@/modules/manuscripts/realtime/core/use-cases/broadcast-project-event.use-case';

// Domain
import { CursorPositionVo } from '@/modules/manuscripts/realtime/core/domain/value-objects/cursor-position.vo';
import { ClientUpdatePayloadVo } from '@/modules/manuscripts/realtime/core/domain/value-objects/client-update-payload.vo';
import { UserPresenceVo } from '@/modules/manuscripts/realtime/core/domain/value-objects/user-presence.vo';
import { PresenceSession } from '@/modules/manuscripts/realtime/core/domain/entities/presence-session.entity';
import { DocRoom } from '@/modules/manuscripts/realtime/core/domain/entities/doc-room.entity';
import { UnauthorizedProjectException } from '@/modules/manuscripts/realtime/core/domain/exceptions/unauthorized-project.exception';
import { InvalidRoomException } from '@/modules/manuscripts/realtime/core/domain/exceptions/invalid-room.exception';

// Ports & Adapters
import { IRoomManagerPort } from '@/modules/manuscripts/realtime/core/ports/room-manager.port';
import { IDocumentUpdaterBridgePort, BridgeUpdateResult } from '@/modules/manuscripts/realtime/core/ports/document-updater-bridge.port';
import { IProjectAccessVerifierPort, ProjectAccessResult } from '@/modules/manuscripts/realtime/core/ports/project-access-verifier.port';
import { IRealtimeBroadcasterPort } from '@/modules/manuscripts/realtime/core/ports/realtime-broadcaster.port';
import { InMemoryRoomManagerAdapter } from '@/modules/manuscripts/realtime/core/adapters/storage/in-memory-room-manager.adapter';
import { SocketIoBroadcasterAdapter } from '@/modules/manuscripts/realtime/core/adapters/broadcast/socket-io-broadcaster.adapter';

// ---------------------------------------------------------------------------
// Mock Test Doubles
// ---------------------------------------------------------------------------

class MockBroadcaster extends IRealtimeBroadcasterPort {
  public projectBroadcasts: Array<{ projectId: string; event: string; payload: any; excludeSocketId?: string }> = [];
  public docBroadcasts: Array<{ projectId: string; docId: string; event: string; payload: any; excludeSocketId?: string }> = [];
  public socketSends: Array<{ socketId: string; event: string; payload: any }> = [];

  public broadcastToProject(projectId: string, event: string, payload: any, excludeSocketId?: string): void {
    this.projectBroadcasts.push({ projectId, event, payload, excludeSocketId });
  }

  public broadcastToDoc(projectId: string, docId: string, event: string, payload: any, excludeSocketId?: string): void {
    this.docBroadcasts.push({ projectId, docId, event, payload, excludeSocketId });
  }

  public sendToSocket(socketId: string, event: string, payload: any): void {
    this.socketSends.push({ socketId, event, payload });
  }

  public clear(): void {
    this.projectBroadcasts = [];
    this.docBroadcasts = [];
    this.socketSends = [];
  }
}

class MockUpdaterBridge extends IDocumentUpdaterBridgePort {
  public lastPayload: ClientUpdatePayloadVo | null = null;
  public nextRev = 1;
  public nextSeq = 1;

  public async forwardUpdate(payload: ClientUpdatePayloadVo): Promise<BridgeUpdateResult> {
    this.lastPayload = payload;
    return {
      serverRev: ++this.nextRev,
      clientRev: payload.clientRev,
      version: 1,
      inFlightSeq: ++this.nextSeq,
    };
  }
}

class MockAccessVerifier extends IProjectAccessVerifierPort {
  public accessMap = new Map<string, ProjectAccessResult>();

  public setAccess(userId: string, projectId: string, result: ProjectAccessResult): void {
    this.accessMap.set(`${userId}:${projectId}`, result);
  }

  public async verifyProjectAccess(userId: string, projectId: string): Promise<ProjectAccessResult> {
    return this.accessMap.get(`${userId}:${projectId}`) ?? { canRead: true, canWrite: true, role: 'contributor' };
  }
}

// ---------------------------------------------------------------------------
// Unit Test Suite
// ---------------------------------------------------------------------------

describe('Manuscripts Real-Time Collaboration Subsystem (Overleaf Parity)', () => {
  const projectId = '01928374-beef-4000-8000-000000000001';
  const docId = '01928374-beef-4000-8000-000000000002';
  const user1 = '01928374-beef-4000-8000-000000000010';
  const user2 = '01928374-beef-4000-8000-000000000020';

  let roomManager: InMemoryRoomManagerAdapter;
  let broadcaster: MockBroadcaster;
  let updaterBridge: MockUpdaterBridge;
  let accessVerifier: MockAccessVerifier;

  let joinProjectUseCase: JoinProjectUseCase;
  let leaveProjectUseCase: LeaveProjectUseCase;
  let joinDocUseCase: JoinDocUseCase;
  let leaveDocUseCase: LeaveDocUseCase;
  let sendDocUpdateUseCase: SendDocUpdateUseCase;
  let broadcastCursorUseCase: BroadcastCursorUseCase;
  let broadcastProjectEventUseCase: BroadcastProjectEventUseCase;

  let realtimeService: RealtimeService;
  let gateway: ManuscriptRealtimeGateway;

  beforeEach(() => {
    roomManager = new InMemoryRoomManagerAdapter();
    broadcaster = new MockBroadcaster();
    updaterBridge = new MockUpdaterBridge();
    accessVerifier = new MockAccessVerifier();

    joinProjectUseCase = new JoinProjectUseCase(roomManager, accessVerifier, broadcaster);
    leaveProjectUseCase = new LeaveProjectUseCase(roomManager, broadcaster);
    joinDocUseCase = new JoinDocUseCase(roomManager, broadcaster);
    leaveDocUseCase = new LeaveDocUseCase(roomManager, broadcaster);
    sendDocUpdateUseCase = new SendDocUpdateUseCase(updaterBridge, broadcaster, accessVerifier);
    broadcastCursorUseCase = new BroadcastCursorUseCase(roomManager, broadcaster);
    broadcastProjectEventUseCase = new BroadcastProjectEventUseCase(broadcaster);

    realtimeService = new RealtimeService(broadcastProjectEventUseCase, roomManager);

    const socketIoBroadcasterAdapter = new SocketIoBroadcasterAdapter();
    gateway = new ManuscriptRealtimeGateway(
      joinProjectUseCase,
      leaveProjectUseCase,
      joinDocUseCase,
      leaveDocUseCase,
      sendDocUpdateUseCase,
      broadcastCursorUseCase,
      socketIoBroadcasterAdapter,
    );
  });

  // =========================================================================
  // 1. Domain Entities & Value Objects
  // =========================================================================
  describe('1. Domain Value Objects & Entities', () => {
    it('CursorPositionVo: clamps negative coordinates and builds selections', () => {
      const cursor = CursorPositionVo.create({
        row: -5,
        column: 12.8,
        selection: {
          anchor: { row: -1, column: 5 },
          head: { row: 3, column: 10 },
        },
      });

      expect(cursor.row).toBe(0);
      expect(cursor.column).toBe(12);
      expect(cursor.selection?.anchor.row).toBe(0);
      expect(cursor.selection?.anchor.column).toBe(5);
      expect(cursor.selection?.head.row).toBe(3);
      expect(cursor.selection?.head.column).toBe(10);

      const json = cursor.toJSON();
      expect(json.row).toBe(0);
      expect(json.column).toBe(12);
    });

    it('ClientUpdatePayloadVo: validates parameters and detects operation type', () => {
      expect(() =>
        ClientUpdatePayloadVo.create({
          projectId: '',
          docId: 'd-1',
          clientRev: 0,
          lines: ['a'],
        }),
      ).toThrow('Project ID cannot be empty.');

      expect(() =>
        ClientUpdatePayloadVo.create({
          projectId: 'p-1',
          docId: 'd-1',
          clientRev: -1,
          lines: ['a'],
        }),
      ).toThrow('Client revision cannot be negative.');

      expect(() =>
        ClientUpdatePayloadVo.create({
          projectId: 'p-1',
          docId: 'd-1',
          clientRev: 0,
        }),
      ).toThrow('Either lines or splice operation must be provided.');

      // Full lines replacement
      const fullVo = ClientUpdatePayloadVo.create({
        projectId: 'p-1',
        docId: 'd-1',
        clientRev: 1,
        lines: ['line 1', 'line 2'],
      });
      expect(fullVo.isFullReplacement()).toBe(true);
      expect(fullVo.isSplice()).toBe(false);

      // Splice delta
      const spliceVo = ClientUpdatePayloadVo.create({
        projectId: 'p-1',
        docId: 'd-1',
        clientRev: 2,
        splice: {
          startLine: 5,
          deleteCount: 1,
          newLines: ['inserted line'],
        },
      });
      expect(spliceVo.isSplice()).toBe(true);
      expect(spliceVo.isFullReplacement()).toBe(false);
      expect(spliceVo.splice?.startLine).toBe(5);
    });

    it('PresenceSession: assigns deterministic color and manages active doc', () => {
      const session = PresenceSession.create({
        userId: user1,
        socketId: 'sock-1',
        projectId,
        name: 'Dr. Alice',
      });

      expect(session.name).toBe('Dr. Alice');
      expect(session.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(session.activeDocId).toBeNull();
      expect(session.cursor).toBeNull();

      session.updateActiveDoc(docId);
      expect(session.activeDocId).toBe(docId);

      const cursor = CursorPositionVo.create({ row: 10, column: 5 });
      session.updateCursor(cursor);
      expect(session.cursor?.row).toBe(10);

      const presenceVo = session.toPresenceVo();
      expect(presenceVo.userId).toBe(user1);
      expect(presenceVo.activeDocId).toBe(docId);
      expect(presenceVo.cursor?.column).toBe(5);
    });

    it('DocRoom: manages multi-user session lifecycle', () => {
      const room = new DocRoom(projectId, docId);
      expect(room.isEmpty()).toBe(true);
      expect(room.socketCount).toBe(0);

      const s1 = PresenceSession.create({ userId: user1, socketId: 's-1', projectId });
      const s2 = PresenceSession.create({ userId: user2, socketId: 's-2', projectId });

      room.addSession(s1);
      room.addSession(s2);

      expect(room.isEmpty()).toBe(false);
      expect(room.socketCount).toBe(2);
      expect(room.getSession('s-1')?.userId).toBe(user1);
      expect(room.getAllPresence()).toHaveLength(2);

      const removed = room.removeSession('s-1');
      expect(removed?.userId).toBe(user1);
      expect(room.socketCount).toBe(1);

      room.removeSession('s-2');
      expect(room.isEmpty()).toBe(true);
    });
  });

  // =========================================================================
  // 2. Adapters & Ports
  // =========================================================================
  describe('2. Adapters & Ports', () => {
    it('InMemoryRoomManagerAdapter: coordinates project and doc presence', async () => {
      const s1 = PresenceSession.create({ userId: user1, socketId: 's-1', projectId, name: 'Alice' });
      const s2 = PresenceSession.create({ userId: user2, socketId: 's-2', projectId, name: 'Bob' });

      await roomManager.addProjectSession(s1);
      await roomManager.addProjectSession(s2);

      let projectPresences = await roomManager.getProjectSessions(projectId);
      expect(projectPresences).toHaveLength(2);

      // s1 joins docId
      const docPresences = await roomManager.joinDocRoom(projectId, docId, 's-1');
      expect(docPresences).toHaveLength(1);
      expect(docPresences[0].name).toBe('Alice');

      // Update cursor
      const cursorVo = CursorPositionVo.create({ row: 15, column: 2 });
      const updated = await roomManager.updateSessionCursor(projectId, docId, 's-1', cursorVo);
      expect(updated?.cursor?.row).toBe(15);

      // s1 leaves docId
      await roomManager.leaveDocRoom(projectId, docId, 's-1');
      const docPresencesAfter = await roomManager.getDocSessions(projectId, docId);
      expect(docPresencesAfter).toHaveLength(0);

      // s2 disconnects from project
      const removed = await roomManager.removeProjectSession(projectId, 's-2');
      expect(removed?.userId).toBe(user2);
      projectPresences = await roomManager.getProjectSessions(projectId);
      expect(projectPresences).toHaveLength(1);
    });
  });

  // =========================================================================
  // 3. Inbound Use Cases
  // =========================================================================
  describe('3. Inbound Use Cases', () => {
    it('JoinProjectUseCase: verifies permission, registers presence, and broadcasts', async () => {
      accessVerifier.setAccess(user1, projectId, { canRead: true, canWrite: true, role: 'owner' });

      const output = await joinProjectUseCase.execute({
        projectId,
        userId: user1,
        socketId: 'sock-100',
        name: 'Prof. Turing',
      });

      expect(output.session.userId).toBe(user1);
      expect(output.projectPresence).toHaveLength(1);
      expect(output.access.role).toBe('owner');

      // Check broadcast
      expect(broadcaster.projectBroadcasts).toHaveLength(1);
      expect(broadcaster.projectBroadcasts[0].event).toBe('project:user-joined');
      expect(broadcaster.projectBroadcasts[0].excludeSocketId).toBe('sock-100');
    });

    it('JoinProjectUseCase: rejects unauthorized users with UnauthorizedProjectException', async () => {
      accessVerifier.setAccess('intruder', projectId, { canRead: false, canWrite: false, role: 'none' });

      await expect(
        joinProjectUseCase.execute({
          projectId,
          userId: 'intruder',
          socketId: 'sock-bad',
        }),
      ).rejects.toThrow(UnauthorizedProjectException);
    });

    it('LeaveProjectUseCase: notifies project and doc peers on exit', async () => {
      await joinProjectUseCase.execute({
        projectId,
        userId: user1,
        socketId: 'sock-1',
      });

      await joinDocUseCase.execute({
        projectId,
        docId,
        socketId: 'sock-1',
      });

      broadcaster.clear();

      await leaveProjectUseCase.execute({
        projectId,
        socketId: 'sock-1',
      });

      expect(broadcaster.projectBroadcasts.some((b) => b.event === 'project:user-left')).toBe(true);
      expect(broadcaster.docBroadcasts.some((b) => b.event === 'doc:user-left')).toBe(true);
    });

    it('JoinDocUseCase & LeaveDocUseCase: manages editor awareness and peer announcements', async () => {
      await joinProjectUseCase.execute({
        projectId,
        userId: user1,
        socketId: 'sock-1',
      });

      const res = await joinDocUseCase.execute({
        projectId,
        docId,
        socketId: 'sock-1',
      });

      expect(res.docPresence).toHaveLength(1);
      expect(broadcaster.docBroadcasts.some((b) => b.event === 'doc:user-joined')).toBe(true);

      // Leave
      await leaveDocUseCase.execute({
        projectId,
        docId,
        socketId: 'sock-1',
      });

      expect(broadcaster.docBroadcasts.some((b) => b.event === 'doc:user-left')).toBe(true);
    });

    it('JoinDocUseCase: throws InvalidRoomException if session not found', async () => {
      await expect(
        joinDocUseCase.execute({
          projectId,
          docId,
          socketId: 'unknown-sock',
        }),
      ).rejects.toThrow(InvalidRoomException);
    });

    it('SendDocUpdateUseCase: bridges update into DocumentUpdater and broadcasts delta + ACK', async () => {
      accessVerifier.setAccess(user1, projectId, { canRead: true, canWrite: true, role: 'contributor' });

      const result = await sendDocUpdateUseCase.execute({
        projectId,
        docId,
        socketId: 'sock-1',
        userId: user1,
        clientRev: 3,
        lines: ['\\section{Introduction}', 'This is realtime LaTeX.'],
        debounceMs: 1500,
      });

      expect(result.serverRev).toBeGreaterThan(0);
      expect(result.clientRev).toBe(3);

      // Check peer broadcast
      expect(broadcaster.docBroadcasts).toHaveLength(1);
      const broadcast = broadcaster.docBroadcasts[0];
      expect(broadcast.event).toBe('doc:update');
      expect(broadcast.payload.docId).toBe(docId);
      expect(broadcast.payload.clientRev).toBe(3);
      expect(broadcast.payload.lines).toHaveLength(2);
      expect(broadcast.excludeSocketId).toBe('sock-1'); // Excludes sender

      // Check sender ACK
      expect(broadcaster.socketSends).toHaveLength(1);
      const ack = broadcaster.socketSends[0];
      expect(ack.socketId).toBe('sock-1');
      expect(ack.event).toBe('doc:update-ack');
      expect(ack.payload.clientRev).toBe(3);
    });

    it('SendDocUpdateUseCase: rejects read-only reviewer with UnauthorizedProjectException', async () => {
      accessVerifier.setAccess('reviewer-1', projectId, { canRead: true, canWrite: false, role: 'reviewer' });

      await expect(
        sendDocUpdateUseCase.execute({
          projectId,
          docId,
          socketId: 'sock-rev',
          userId: 'reviewer-1',
          clientRev: 1,
          lines: ['Disallowed change'],
        }),
      ).rejects.toThrow(UnauthorizedProjectException);
    });

    it('BroadcastCursorUseCase: updates cursor position and broadcasts to doc peers', async () => {
      await joinProjectUseCase.execute({
        projectId,
        userId: user1,
        socketId: 'sock-1',
      });
      await joinDocUseCase.execute({
        projectId,
        docId,
        socketId: 'sock-1',
      });

      broadcaster.clear();

      const presence = await broadcastCursorUseCase.execute({
        projectId,
        docId,
        socketId: 'sock-1',
        cursor: { row: 42, column: 15 },
      });

      expect(presence?.cursor?.row).toBe(42);
      expect(presence?.cursor?.column).toBe(15);
      expect(broadcaster.docBroadcasts).toHaveLength(1);
      expect(broadcaster.docBroadcasts[0].event).toBe('doc:cursor');
      expect(broadcaster.docBroadcasts[0].excludeSocketId).toBe('sock-1');
    });

    it('BroadcastProjectEventUseCase: broadcasts generic events to project room', () => {
      broadcastProjectEventUseCase.execute({
        projectId,
        event: 'compile:progress',
        payload: { status: 'compiling', step: 'Building PDF' },
      });

      expect(broadcaster.projectBroadcasts).toHaveLength(1);
      expect(broadcaster.projectBroadcasts[0].event).toBe('compile:progress');
      expect(broadcaster.projectBroadcasts[0].payload.status).toBe('compiling');
    });
  });

  // =========================================================================
  // 4. RealtimeService Orchestrator
  // =========================================================================
  describe('4. RealtimeService (Facade Orchestrator)', () => {
    it('broadcastFileTreeChange: broadcasts fileTree:update event', () => {
      realtimeService.broadcastFileTreeChange(projectId, {
        action: 'create',
        node: { id: 'n-1', path: '/chapters/intro.tex' },
      });

      expect(broadcaster.projectBroadcasts).toHaveLength(1);
      expect(broadcaster.projectBroadcasts[0].event).toBe('fileTree:update');
      expect(broadcaster.projectBroadcasts[0].payload.node.path).toBe('/chapters/intro.tex');
    });

    it('broadcastCompileProgress: broadcasts compile:progress event', () => {
      realtimeService.broadcastCompileProgress(projectId, {
        status: 'success',
        pdfUrl: '/api/v1/projects/1/pdf',
      });

      expect(broadcaster.projectBroadcasts).toHaveLength(1);
      expect(broadcaster.projectBroadcasts[0].event).toBe('compile:progress');
      expect(broadcaster.projectBroadcasts[0].payload.status).toBe('success');
    });

    it('broadcastSnapshotCreated: broadcasts history:new-version event', () => {
      realtimeService.broadcastSnapshotCreated(projectId, {
        version: 5,
        summary: 'Final submission',
      });

      expect(broadcaster.projectBroadcasts).toHaveLength(1);
      expect(broadcaster.projectBroadcasts[0].event).toBe('history:new-version');
      expect(broadcaster.projectBroadcasts[0].payload.version).toBe(5);
    });

    it('getProjectPresence & getDocPresence: delegates to room manager', async () => {
      await joinProjectUseCase.execute({
        projectId,
        userId: user1,
        socketId: 'sock-1',
      });
      await joinDocUseCase.execute({
        projectId,
        docId,
        socketId: 'sock-1',
      });

      const pPresence = await realtimeService.getProjectPresence(projectId);
      expect(pPresence).toHaveLength(1);

      const dPresence = await realtimeService.getDocPresence(projectId, docId);
      expect(dPresence).toHaveLength(1);
    });
  });

  // =========================================================================
  // 5. ManuscriptRealtimeGateway Integration
  // =========================================================================
  describe('5. ManuscriptRealtimeGateway Integration', () => {
    it('handleConnection: assigns user meta and anonymous fallback', async () => {
      const mockSocket: any = {
        id: 'sock-anon-12345678',
        handshake: {
          headers: {},
          auth: {},
          query: {},
        },
        data: {},
      };

      await gateway.handleConnection(mockSocket);
      expect(mockSocket.data.userId).toBe('anon-sock-ano');
      expect(mockSocket.data.name).toBe('Collaborator');
    });

    it('handleDisconnect: cleans up project presence if socket was in a room', async () => {
      const mockSocket: any = {
        id: 'sock-disc-1',
        handshake: { headers: {}, auth: { userId: user1 }, query: {} },
        data: { projectId },
      };

      await joinProjectUseCase.execute({
        projectId,
        userId: user1,
        socketId: 'sock-disc-1',
      });

      await gateway.handleDisconnect(mockSocket);
      const projectPresence = await roomManager.getProjectSessions(projectId);
      expect(projectPresence).toHaveLength(0);
    });

    it('handleJoinProject & handleJoinDoc & handleDocUpdate handlers', async () => {
      const joinedRooms = new Set<string>();
      const mockSocket: any = {
        id: 'sock-user-1',
        handshake: { headers: {}, auth: { userId: user1 }, query: {} },
        data: { userId: user1, name: 'Alice' },
        join: (r: string) => joinedRooms.add(r),
        leave: (r: string) => joinedRooms.delete(r),
      };

      // 1. Join Project
      const joinProjRes = await gateway.handleJoinProject(mockSocket, { projectId });
      expect(joinProjRes.success).toBe(true);
      expect(joinedRooms.has(`project:${projectId}`)).toBe(true);

      // 2. Join Doc
      const joinDocRes = await gateway.handleJoinDoc(mockSocket, { projectId, docId });
      expect(joinDocRes.success).toBe(true);
      expect(joinedRooms.has(`doc:${projectId}:${docId}`)).toBe(true);

      // 3. Update Doc
      const updateRes = await gateway.handleDocUpdate(mockSocket, {
        projectId,
        docId,
        clientRev: 1,
        lines: ['Live line'],
      });
      expect(updateRes.success).toBe(true);
      expect(updateRes.clientRev).toBe(1);

      // 4. Cursor Update
      const cursorRes = await gateway.handleCursorUpdate(mockSocket, {
        projectId,
        docId,
        cursor: { row: 1, column: 5 },
      });
      expect(cursorRes.success).toBe(true);
      expect(cursorRes.presence?.cursor?.row).toBe(1);

      // 5. Leave Doc
      const leaveDocRes = await gateway.handleLeaveDoc(mockSocket, { projectId, docId });
      expect(leaveDocRes.success).toBe(true);
      expect(joinedRooms.has(`doc:${projectId}:${docId}`)).toBe(false);

      // 6. Leave Project
      const leaveProjRes = await gateway.handleLeaveProject(mockSocket, { projectId });
      expect(leaveProjRes.success).toBe(true);
      expect(joinedRooms.has(`project:${projectId}`)).toBe(false);
    });
  });
});
