/**
 * test/unit/manuscripts/manuscripts-redis-room-manager.spec.ts
 *
 * Unit tests for RoomStore verifying both local in-memory fallback
 * and multi-node Redis distributed presence querying and state synchronization.
 */

import { RoomStore } from '@/modules/realtime/manuscripts/room.store';
import {
  UserPresence,
  CursorPosition,
} from '@/modules/realtime/manuscripts/types/presence.type';

describe('RoomStore (Distributed Presence)', () => {
  const projectId = 'proj-redis-test-001';
  const docId = 'doc-section-1.tex';

  describe('When Redis is inactive / absent (In-memory fallback)', () => {
    let adapter: RoomStore;

    beforeEach(() => {
      adapter = new RoomStore(undefined);
    });

    it('manages project sessions and retrieves them from fallback memory', async () => {
      const session1: UserPresence = {
        userId: 'u-1',
        socketId: 'sock-1',
        projectId,
        name: 'Researcher Alice',
        lastHeartbeat: Date.now(),
      };
      const session2: UserPresence = {
        userId: 'u-2',
        socketId: 'sock-2',
        projectId,
        name: 'Researcher Bob',
        lastHeartbeat: Date.now(),
      };

      await adapter.addProjectSession(session1);
      await adapter.addProjectSession(session2);

      const presences = await adapter.getProjectSessions(projectId);
      expect(presences).toHaveLength(2);
      expect(presences.map((p: UserPresence) => p.name)).toEqual(
        expect.arrayContaining(['Researcher Alice', 'Researcher Bob']),
      );

      // Remove session
      await adapter.removeProjectSession(projectId, 'sock-1');
      const updated = await adapter.getProjectSessions(projectId);
      expect(updated).toHaveLength(1);
      expect(updated[0].socketId).toBe('sock-2');
    });

    it('manages doc rooms and cursor updates', async () => {
      const session: UserPresence = {
        userId: 'u-1',
        socketId: 'sock-1',
        projectId,
        name: 'Researcher Alice',
        lastHeartbeat: Date.now(),
      };
      await adapter.addProjectSession(session);

      const docUsers = await adapter.joinDocRoom(projectId, docId, 'sock-1');
      expect(docUsers).toHaveLength(1);
      expect(docUsers[0].activeDocId).toBe(docId);

      const cursor: CursorPosition = { row: 12, column: 5 };
      const updatedPresence = await adapter.updateSessionCursor(
        projectId,
        docId,
        'sock-1',
        cursor,
      );
      expect(updatedPresence?.cursor?.row).toBe(12);

      await adapter.leaveDocRoom(projectId, docId, 'sock-1');
      const remainingDocUsers = await adapter.getDocSessions(projectId, docId);
      expect(remainingDocUsers).toHaveLength(0);
    });
  });

  describe('When Redis is active (Multi-node distributed clustering)', () => {
    let adapter: RoomStore;
    let mockClient: any;
    let mockRedisCacheService: any;
    let redisStorage: Map<string, string>;
    let redisSets: Map<string, Set<string>>;

    beforeEach(() => {
      redisStorage = new Map<string, string>();
      redisSets = new Map<string, Set<string>>();

      mockClient = {
        set: jest.fn(async (key: string, value: string) => {
          redisStorage.set(key, value);
          return 'OK';
        }),
        get: jest.fn(async (key: string) => {
          return redisStorage.get(key) || null;
        }),
        del: jest.fn(async (key: string) => {
          redisStorage.delete(key);
          return 1;
        }),
        sadd: jest.fn(async (key: string, member: string) => {
          let s = redisSets.get(key);
          if (!s) {
            s = new Set<string>();
            redisSets.set(key, s);
          }
          s.add(member);
          return 1;
        }),
        srem: jest.fn(async (key: string, ...members: string[]) => {
          const s = redisSets.get(key);
          if (s) {
            members.forEach((m) => s.delete(m));
          }
          return members.length;
        }),
        smembers: jest.fn(async (key: string) => {
          const s = redisSets.get(key);
          return s ? Array.from(s) : [];
        }),
        mget: jest.fn(async (...keys: string[]) => {
          return keys.map((k) => redisStorage.get(k) || null);
        }),
      };

      mockRedisCacheService = {
        isReady: () => true,
        getClient: () => mockClient,
      };

      adapter = new RoomStore(mockRedisCacheService);
    });

    it('synchronizes presence sessions across simulated pods via Redis SMEMBERS & MGET', async () => {
      const session1: UserPresence = {
        userId: 'u-1',
        socketId: 'sock-podA-1',
        projectId,
        name: 'Pod A User',
        lastHeartbeat: Date.now(),
      };
      await adapter.addProjectSession(session1);

      const session2: UserPresence = {
        userId: 'u-2',
        socketId: 'sock-podB-2',
        projectId,
        name: 'Pod B User',
        lastHeartbeat: Date.now(),
      };
      redisStorage.set(
        `manuscript:presence:sock-podB-2`,
        JSON.stringify(session2),
      );
      let pSet = redisSets.get(`manuscript:project_rooms:${projectId}`);
      if (!pSet) {
        pSet = new Set();
        redisSets.set(`manuscript:project_rooms:${projectId}`, pSet);
      }
      pSet.add('sock-podB-2');

      const presences = await adapter.getProjectSessions(projectId);
      expect(presences).toHaveLength(2);
      const names = presences.map((p: UserPresence) => p.name);
      expect(names).toContain('Pod A User');
      expect(names).toContain('Pod B User');
    });

    it('prunes dead socket IDs when Redis TTL expires', async () => {
      let pSet = redisSets.get(`manuscript:project_rooms:${projectId}`);
      if (!pSet) {
        pSet = new Set();
        redisSets.set(`manuscript:project_rooms:${projectId}`, pSet);
      }
      pSet.add('stale-dead-socket-999');

      const liveSession: UserPresence = {
        userId: 'u-live',
        socketId: 'sock-live',
        projectId,
        name: 'Active User',
        lastHeartbeat: Date.now(),
      };
      await adapter.addProjectSession(liveSession);

      const presences = await adapter.getProjectSessions(projectId);
      expect(presences).toHaveLength(1);
      expect(presences[0].name).toBe('Active User');

      expect(mockClient.srem).toHaveBeenCalledWith(
        `manuscript:project_rooms:${projectId}`,
        'stale-dead-socket-999',
      );
    });

    it('synchronizes doc room presence and cursor position across pods', async () => {
      const session: UserPresence = {
        userId: 'u-1',
        socketId: 'sock-1',
        projectId,
        name: 'Author 1',
        lastHeartbeat: Date.now(),
      };
      await adapter.addProjectSession(session);

      const docUsers = await adapter.joinDocRoom(projectId, docId, 'sock-1');
      expect(docUsers).toHaveLength(1);
      expect(docUsers[0].activeDocId).toBe(docId);

      const cursor: CursorPosition = {
        row: 42,
        column: 10,
        selection: {
          anchor: { row: 42, column: 5 },
          head: { row: 42, column: 10 },
        },
      };
      const updated = await adapter.updateSessionCursor(
        projectId,
        docId,
        'sock-1',
        cursor,
      );
      expect(updated?.cursor?.row).toBe(42);
      expect(updated?.cursor?.column).toBe(10);
      expect(updated?.cursor?.selection?.anchor.column).toBe(5);

      const docSessions = await adapter.getDocSessions(projectId, docId);
      expect(docSessions).toHaveLength(1);
      expect(docSessions[0].cursor?.row).toBe(42);

      await adapter.leaveDocRoom(projectId, docId, 'sock-1');
      const remainingDocUsers = await adapter.getDocSessions(projectId, docId);
      expect(remainingDocUsers).toHaveLength(0);
    });

    it('cleans up doc room and project room sets when session is removed', async () => {
      const session: UserPresence = {
        userId: 'u-1',
        socketId: 'sock-1',
        projectId,
        name: 'Author 1',
        lastHeartbeat: Date.now(),
      };
      await adapter.addProjectSession(session);
      await adapter.joinDocRoom(projectId, docId, 'sock-1');

      await adapter.removeProjectSession(projectId, 'sock-1');

      expect(mockClient.del).toHaveBeenCalledWith('manuscript:presence:sock-1');
      expect(mockClient.srem).toHaveBeenCalledWith(
        `manuscript:project_rooms:${projectId}`,
        'sock-1',
      );
      expect(mockClient.srem).toHaveBeenCalledWith(
        `manuscript:doc_rooms:${projectId}:${docId}`,
        'sock-1',
      );
    });
  });
});
