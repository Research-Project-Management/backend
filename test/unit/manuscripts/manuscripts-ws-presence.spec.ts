import { PresenceMapper } from '@/modules/realtime/manuscripts/presence.mapper';
import { ManuscriptsGateway } from '@/modules/realtime/manuscripts/manuscripts.gateway';

describe('Presence Sanitization & Leave Semantics (US8 & RT-03 / Section 7)', () => {
  describe('1. PresenceMapper Sanitization', () => {
    it('maps client data to strict public presence shape without leaking auth or internal state', () => {
      const rawData = {
        userId: '01928374-beef-4000-8000-000000000001',
        name: 'Alice',
        color: '#ff5733',
        avatar: 'https://example.com/avatar.png',
        projectId: 'project-secret-id',
        activeDocId: 'doc-secret-id',
        authenticated: true,
        secretField: 'must-not-leak',
      };

      const publicPresence = PresenceMapper.toPublicPresence(rawData, 'sock-123');

      expect(publicPresence).toEqual({
        userId: '01928374-beef-4000-8000-000000000001',
        name: 'Alice',
        color: '#ff5733',
        avatar: 'https://example.com/avatar.png',
        socketId: 'sock-123',
      });

      // Assert strictly stripped fields
      expect((publicPresence as any).authenticated).toBeUndefined();
      expect((publicPresence as any).projectId).toBeUndefined();
      expect((publicPresence as any).activeDocId).toBeUndefined();
      expect((publicPresence as any).secretField).toBeUndefined();
    });

    it('sanitizes colors: validates valid hex and falls back on invalid formats', () => {
      expect(PresenceMapper.sanitizeColor('#fff')).toBe('#fff');
      expect(PresenceMapper.sanitizeColor('#10b981')).toBe('#10b981');
      expect(PresenceMapper.sanitizeColor('red')).toBe('#3b82f6');
      expect(PresenceMapper.sanitizeColor('javascript:alert(1)')).toBe('#3b82f6');
      expect(PresenceMapper.sanitizeColor('')).toBe('#3b82f6');
      expect(PresenceMapper.sanitizeColor(undefined)).toBe('#3b82f6');
    });

    it('sanitizes avatars: validates URLs and rejects malicious/oversized inputs', () => {
      expect(
        PresenceMapper.sanitizeAvatar('https://secure.example.com/img.png'),
      ).toBe('https://secure.example.com/img.png');
      expect(
        PresenceMapper.sanitizeAvatar('data:image/png;base64,iVBORw0KGgo='),
      ).toBe('data:image/png;base64,iVBORw0KGgo=');
      expect(PresenceMapper.sanitizeAvatar('javascript:alert(1)')).toBeUndefined();
      expect(PresenceMapper.sanitizeAvatar('A'.repeat(1001))).toBeUndefined();
      expect(PresenceMapper.sanitizeAvatar('')).toBeUndefined();
      expect(PresenceMapper.sanitizeAvatar(null)).toBeUndefined();
    });
  });

  describe('2. Unjoined Sockets Leave Semantics (RT-03)', () => {
    let gateway: ManuscriptsGateway;
    let mockService: any;

    beforeEach(() => {
      mockService = {
        leaveProject: jest.fn(),
        leaveDoc: jest.fn(),
      };
      gateway = new ManuscriptsGateway(
        mockService,
        {} as any,
        {} as any,
      );
      gateway.server = {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      } as any;
    });

    it('does NOT broadcast or call service when socket leaves a project it never joined', async () => {
      const socket: any = {
        id: 'sock-unjoined-1',
        data: {
          userId: 'user-1',
          projectId: null,
          activeDocId: null,
        },
        leave: jest.fn(),
      };

      const res = await gateway.handleLeaveProject(socket, {
        projectId: '01928374-beef-4000-8000-000000000001',
      });

      expect(res).toEqual({ success: true });
      expect(mockService.leaveProject).not.toHaveBeenCalled();
      expect(socket.leave).not.toHaveBeenCalled();
      expect(gateway.server.emit).not.toHaveBeenCalled();
    });

    it('does NOT broadcast or call service when socket leaves a doc it never joined', async () => {
      const socket: any = {
        id: 'sock-unjoined-2',
        data: {
          userId: 'user-2',
          projectId: '01928374-beef-4000-8000-000000000001',
          activeDocId: null, // joined project but NOT this doc
        },
        leave: jest.fn(),
      };

      const res = await gateway.handleLeaveDoc(socket, {
        projectId: '01928374-beef-4000-8000-000000000001',
        docId: '01928374-beef-4000-8000-000000000002',
      });

      expect(res).toEqual({ success: true });
      expect(mockService.leaveDoc).not.toHaveBeenCalled();
      expect(socket.leave).not.toHaveBeenCalled();
      expect(gateway.server.emit).not.toHaveBeenCalled();
    });
  });
});
