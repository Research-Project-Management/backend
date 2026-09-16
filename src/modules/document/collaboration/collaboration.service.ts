import { Injectable, Optional, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisCacheService } from '@/core/cache/redis.service';
import { CursorPositionDto } from './dto/collaboration.dto';

export interface PresenceUser {
  id: string;
  name: string;
  avatar?: string;
  role: string;
  color: string;
  cursor?: CursorPositionDto;
  lastHeartbeat: number;
}

const USER_COLORS = [
  '#3B82F6', // Blue
  '#10B981', // Emerald
  '#F59E0B', // Amber
  '#EF4444', // Red
  '#8B5CF6', // Purple
  '#EC4899', // Pink
  '#06B6D4', // Cyan
  '#84CC16', // Lime
];

function assignUserColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % USER_COLORS.length;
  return USER_COLORS[index];
}

@Injectable()
export class CollaborationService {
  private readonly logger = new Logger(CollaborationService.name);
  private readonly presenceRooms = new Map<string, Map<string, PresenceUser>>();
  private static readonly PRESENCE_TIMEOUT_MS = 35_000; // 35 seconds

  constructor(
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly redis?: RedisCacheService,
  ) {}

  /**
   * Registers/updates a user's presence & cursor location in a document room.
   */
  async updatePresence(
    pageId: string,
    user: { id: string; name: string; avatar?: string; role: string },
    cursor?: CursorPositionDto,
  ): Promise<PresenceUser[]> {
    let room = this.presenceRooms.get(pageId);
    if (!room) {
      room = new Map<string, PresenceUser>();
      this.presenceRooms.set(pageId, room);
    }

    const now = Date.now();
    const isNew = !room.has(user.id);
    const existing = room.get(user.id);

    const presenceUser: PresenceUser = {
      id: user.id,
      name: user.name || 'Anonymous Researcher',
      avatar: user.avatar,
      role: user.role,
      color: existing?.color || assignUserColor(user.id),
      cursor: cursor || existing?.cursor,
      lastHeartbeat: now,
    };

    room.set(user.id, presenceUser);

    // Clean up stale users in this room
    this.cleanStaleUsers(pageId, now);

    // Emit event for real-time SSE stream
    this.eventEmitter?.emit('document.collaboration.event', {
      pageId,
      type: isNew ? 'user-joined' : 'cursor-updated',
      user: presenceUser,
      timestamp: now,
    });

    return this.getActiveUsers(pageId);
  }

  /**
   * Explicitly leaves a document room.
   */
  async leaveRoom(pageId: string, userId: string): Promise<PresenceUser[]> {
    const room = this.presenceRooms.get(pageId);
    if (room && room.has(userId)) {
      room.delete(userId);
      if (room.size === 0) {
        this.presenceRooms.delete(pageId);
      }

      this.eventEmitter?.emit('document.collaboration.event', {
        pageId,
        type: 'user-left',
        userId,
        timestamp: Date.now(),
      });
    }

    return this.getActiveUsers(pageId);
  }

  /**
   * Retrieves list of active users in a document room.
   */
  getActiveUsers(pageId: string): PresenceUser[] {
    const room = this.presenceRooms.get(pageId);
    if (!room) return [];
    this.cleanStaleUsers(pageId, Date.now());
    return Array.from(room.values());
  }

  /**
   * Broadcasts document lock state change to all active collaborators.
   */
  broadcastLockChange(pageId: string, isLocked: boolean, lockedBy: string) {
    const payload = {
      pageId,
      type: isLocked ? 'page-locked' : 'page-unlocked',
      isLocked,
      lockedBy,
      timestamp: Date.now(),
    };
    this.eventEmitter?.emit('document.collaboration.event', payload);
    // Also emit canonical 'lock-updated' for full cross-system compatibility
    this.eventEmitter?.emit('document.collaboration.event', {
      ...payload,
      type: 'lock-updated',
    });
  }

  private cleanStaleUsers(pageId: string, now: number) {
    const room = this.presenceRooms.get(pageId);
    if (!room) return;

    for (const [userId, user] of room.entries()) {
      if (now - user.lastHeartbeat > CollaborationService.PRESENCE_TIMEOUT_MS) {
        room.delete(userId);
        this.eventEmitter?.emit('document.collaboration.event', {
          pageId,
          type: 'user-left',
          userId,
          timestamp: now,
        });
      }
    }
  }
}
