import { CollaborationGateway } from '@/modules/document/collaboration/collaboration.gateway';
import { CollaborationService } from '@/modules/document/collaboration/collaboration.service';
import { YjsDocumentManager } from '@/modules/document/collaboration/yjs-document.manager';
import { PageRepository } from '@/modules/document/page/page.repository';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

describe('CollaborationGateway (Overleaf Security & RBAC Gating)', () => {
  let gateway: CollaborationGateway;
  let mockCollaborationService: jest.Mocked<Partial<CollaborationService>>;
  let mockYjsManager: jest.Mocked<Partial<YjsDocumentManager>>;
  let mockPageRepo: jest.Mocked<Partial<PageRepository>>;
  let mockJwtService: jest.Mocked<Partial<JwtService>>;
  let mockConfigService: jest.Mocked<Partial<ConfigService>>;
  let mockPrisma: any;
  let mockRedis: any;

  const mockSecret = 'super-secret-jwt-key';
  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockPageId = '22222222-2222-2222-2222-222222222222';
  const mockProjectId = '33333333-3333-3333-3333-333333333333';

  beforeEach(() => {
    mockCollaborationService = {
      updatePresence: jest.fn().mockResolvedValue([
        {
          id: mockUserId,
          name: 'Alice Author',
          role: 'CONTRIBUTOR',
          color: '#3B82F6',
          lastHeartbeat: Date.now(),
        },
      ]),
      leaveRoom: jest.fn().mockResolvedValue([]),
      broadcastLockChange: jest.fn().mockResolvedValue(undefined),
    };

    mockYjsManager = {
      getOrCreateDoc: jest.fn().mockResolvedValue({} as any),
      applyUpdate: jest.fn(),
      handleClientLeave: jest.fn(),
    };

    mockPageRepo = {
      findPageById: jest.fn().mockResolvedValue({
        id: mockPageId,
        projectId: mockProjectId,
        content: 'Sample content',
      } as any),
    };

    mockJwtService = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: mockUserId,
        email: 'alice@flux.local',
        name: 'Alice Author',
        iat: Math.floor(Date.now() / 1000),
      }),
    };

    mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'JWT_SECRET') return mockSecret;
        return null;
      }),
    };

    mockPrisma = {
      project: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      projectMember: {
        findUnique: jest.fn().mockResolvedValue({
          role: 'CONTRIBUTOR',
        }),
      },
    };

    mockRedis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };

    gateway = new CollaborationGateway(
      mockCollaborationService as CollaborationService,
      mockYjsManager as YjsDocumentManager,
      mockPageRepo as PageRepository,
      mockJwtService as JwtService,
      mockConfigService as ConfigService,
      mockPrisma,
      mockRedis,
    );

    gateway.server = {
      to: jest.fn().mockReturnValue({
        emit: jest.fn(),
      }),
    } as any;
  });

  describe('handleConnection (Authentication Guard)', () => {
    it('should reject unauthenticated socket with missing token', async () => {
      const mockSocket = {
        id: 'socket-1',
        handshake: { auth: {}, headers: {} },
        emit: jest.fn(),
        disconnect: jest.fn(),
        data: {},
      } as any;

      await gateway.handleConnection(mockSocket);

      expect(mockSocket.emit).toHaveBeenCalledWith(
        'auth_error',
        expect.objectContaining({
          message: expect.stringContaining('missing token'),
        }),
      );
      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
      expect(mockSocket.data.user).toBeUndefined();
    });

    it('should reject socket when JWT verification fails', async () => {
      mockJwtService.verifyAsync = jest
        .fn()
        .mockRejectedValue(new Error('Invalid signature'));

      const mockSocket = {
        id: 'socket-2',
        handshake: { auth: { token: 'bad-token' }, headers: {} },
        emit: jest.fn(),
        disconnect: jest.fn(),
        data: {},
      } as any;

      await gateway.handleConnection(mockSocket);

      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'auth_error',
        expect.objectContaining({
          message: expect.stringContaining('Invalid or expired token'),
        }),
      );
    });

    it('should reject socket if user token is revoked in Redis', async () => {
      // Return a revocation timestamp in the future relative to token iat
      mockRedis.get = jest.fn().mockResolvedValue(Date.now() + 100000);

      const mockSocket = {
        id: 'socket-3',
        handshake: { auth: { token: 'valid-but-revoked' }, headers: {} },
        emit: jest.fn(),
        disconnect: jest.fn(),
        data: {},
      } as any;

      await gateway.handleConnection(mockSocket);

      expect(mockSocket.disconnect).toHaveBeenCalledWith(true);
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'auth_error',
        expect.objectContaining({
          message: expect.stringContaining('Session has been revoked'),
        }),
      );
    });

    it('should authenticate socket and attach user payload when token is valid', async () => {
      const mockSocket = {
        id: 'socket-4',
        handshake: { auth: { token: 'valid-token' }, headers: {} },
        emit: jest.fn(),
        disconnect: jest.fn(),
        data: {},
      } as any;

      await gateway.handleConnection(mockSocket);

      expect(mockSocket.disconnect).not.toHaveBeenCalled();
      expect(mockSocket.data.user).toEqual({
        id: mockUserId,
        email: 'alice@flux.local',
        name: 'Alice Author',
      });
    });
  });

  describe('handleJoinDocument & RBAC Gating', () => {
    let authenticatedSocket: any;

    beforeEach(() => {
      authenticatedSocket = {
        id: 'socket-auth',
        data: {
          user: {
            id: mockUserId,
            email: 'alice@flux.local',
            name: 'Alice Author',
          },
        },
        join: jest.fn().mockResolvedValue(undefined),
        leave: jest.fn().mockResolvedValue(undefined),
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
        emit: jest.fn(),
        disconnect: jest.fn(),
      };
    });

    it('should reject join if payload user ID does not match authenticated token (anti-spoofing)', async () => {
      const result = await gateway.handleJoinDocument(authenticatedSocket, {
        pageId: mockPageId,
        user: { id: 'imposter-user-id' },
      });

      expect(result).toEqual({
        status: 'error',
        message: 'User ID does not match authenticated token',
      });
    });

    it('should grant canWrite=true for CONTRIBUTOR role', async () => {
      mockPrisma.projectMember.findUnique = jest.fn().mockResolvedValue({
        role: 'CONTRIBUTOR',
      });

      const result = await gateway.handleJoinDocument(authenticatedSocket, {
        pageId: mockPageId,
      });

      expect(result).toEqual(
        expect.objectContaining({
          status: 'ok',
          canWrite: true,
          role: 'CONTRIBUTOR',
        }),
      );
    });

    it('should grant canWrite=false (Read-Only) for REVIEWER role', async () => {
      mockPrisma.projectMember.findUnique = jest.fn().mockResolvedValue({
        role: 'REVIEWER',
      });

      const result = await gateway.handleJoinDocument(authenticatedSocket, {
        pageId: mockPageId,
      });

      expect(result).toEqual(
        expect.objectContaining({
          status: 'ok',
          canWrite: false,
          role: 'REVIEWER',
        }),
      );
    });

    it('should deny access if user is not a member of the project', async () => {
      mockPrisma.project.findFirst = jest.fn().mockResolvedValue(null);
      mockPrisma.projectMember.findUnique = jest.fn().mockResolvedValue(null);

      const result = await gateway.handleJoinDocument(authenticatedSocket, {
        pageId: mockPageId,
      });

      expect(result).toEqual({
        status: 'forbidden',
        message: 'Access denied: You are not a member of this project',
      });
    });
  });

  describe('Write Protection on Yjs Operations', () => {
    it('should block yjs:update and emit yjs:error when user has Read-Only access', async () => {
      const reviewerSocket = {
        id: 'socket-reviewer',
        data: {
          user: {
            id: mockUserId,
            email: 'rev@flux.local',
            name: 'Bob Reviewer',
          },
        },
        join: jest.fn(),
        leave: jest.fn(),
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
        emit: jest.fn(),
      };

      // Set user as REVIEWER (canWrite = false)
      mockPrisma.projectMember.findUnique = jest.fn().mockResolvedValue({
        role: 'REVIEWER',
      });
      await gateway.handleJoinDocument(reviewerSocket as any, {
        pageId: mockPageId,
      });

      // Attempt to emit an update
      const fakeUpdate = new Uint8Array([1, 2, 3]);
      await gateway.handleYjsUpdate(reviewerSocket as any, {
        pageId: mockPageId,
        update: fakeUpdate,
      });

      // Manager should NOT have received the update
      expect(mockYjsManager.applyUpdate).not.toHaveBeenCalled();
      // Reviewer should receive permission error
      expect(reviewerSocket.emit).toHaveBeenCalledWith(
        'yjs:error',
        expect.objectContaining({
          message: expect.stringContaining(
            'Permission denied: Read-only access',
          ),
        }),
      );
    });

    it('should permit yjs:update and broadcast to room when user has write access', async () => {
      const authorSocket = {
        id: 'socket-author',
        data: {
          user: {
            id: mockUserId,
            email: 'author@flux.local',
            name: 'Alice Author',
          },
        },
        join: jest.fn(),
        leave: jest.fn(),
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
        emit: jest.fn(),
      };

      // Set user as CONTRIBUTOR (canWrite = true)
      mockPrisma.projectMember.findUnique = jest.fn().mockResolvedValue({
        role: 'CONTRIBUTOR',
      });
      await gateway.handleJoinDocument(authorSocket as any, {
        pageId: mockPageId,
      });

      const fakeUpdate = new Uint8Array([4, 5, 6]);
      await gateway.handleYjsUpdate(authorSocket as any, {
        pageId: mockPageId,
        update: fakeUpdate,
      });

      expect(mockYjsManager.applyUpdate).toHaveBeenCalledWith(
        mockPageId,
        fakeUpdate,
        mockUserId,
      );
      expect(authorSocket.to).toHaveBeenCalledWith(`doc:${mockPageId}`);
    });
  });
});
