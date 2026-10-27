import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  Optional,
} from '@nestjs/common';
import { RoomStore } from './room.store';
import { UserPresence, CursorPosition } from './types/presence.type';
import { SendUpdateDto } from './dto/events.dto';
import { RealtimeAccessService } from './realtime-access.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { YjsService } from './yjs.service';

export interface ProjectAccess {
  canRead: boolean;
  canWrite: boolean;
  role: string;
}

export interface DocUpdateResult {
  serverRev: number;
  clientRev: number;
  version: number;
  inFlightSeq: number;
  yjsFrame?: Buffer | null;
}

@Injectable()
export class ManuscriptsService {
  private readonly logger = new Logger(ManuscriptsService.name);

  constructor(
    private readonly roomStore: RoomStore,
    private readonly realtimeAccess: RealtimeAccessService,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional() private readonly yjsService?: YjsService,
  ) {}

  public async verifyAccess(
    userId: string,
    projectId: string,
  ): Promise<ProjectAccess> {
    const access = await this.realtimeAccess.getProjectAccess(
      projectId,
      userId,
    );
    if (access.decision === 'unavailable') {
      throw new ServiceUnavailableException(
        'Realtime authorization service temporarily unavailable',
      );
    }
    return {
      canRead: access.canRead,
      canWrite: access.canWrite,
      role: access.role,
    };
  }

  public async joinProject(input: {
    projectId: string;
    userId: string;
    socketId: string;
    name?: string | null;
    color?: string | null;
    avatar?: string | null;
  }): Promise<{
    session: UserPresence;
    projectPresence: UserPresence[];
    access: ProjectAccess;
  }> {
    const { projectId, userId, socketId, name, color, avatar } = input;

    const access = await this.verifyAccess(userId, projectId);
    if (!access.canRead) {
      throw new ForbiddenException(
        `User ${userId} lacks permission to access project ${projectId}`,
      );
    }

    const session: UserPresence = {
      userId,
      socketId,
      projectId,
      name: name ?? 'Collaborator',
      color: color ?? this.roomStore.getDeterministicColor(userId),
      avatar: avatar ?? null,
      activeDocId: null,
      cursor: null,
      lastHeartbeat: Date.now(),
    };

    await this.roomStore.addProjectSession(session);
    const projectPresence = await this.roomStore.getProjectSessions(projectId);

    return { session, projectPresence, access };
  }

  public async leaveProject(
    projectId: string,
    socketId: string,
  ): Promise<UserPresence | null> {
    return this.roomStore.removeProjectSession(projectId, socketId);
  }

  public async joinDoc(
    projectId: string,
    docId: string,
    socketId: string,
  ): Promise<{ docPresence: UserPresence[] }> {
    const session = this.roomStore.getSession(socketId);
    if (!session) {
      throw new NotFoundException(
        `Session ${socketId} not found in project ${projectId}`,
      );
    }

    const docPresence = await this.roomStore.joinDocRoom(
      projectId,
      docId,
      socketId,
    );
    return { docPresence };
  }

  public async leaveDoc(
    projectId: string,
    docId: string,
    socketId: string,
  ): Promise<void> {
    await this.roomStore.leaveDocRoom(projectId, docId, socketId);
  }

  public async updateCursor(
    projectId: string,
    docId: string,
    socketId: string,
    cursor: CursorPosition,
  ): Promise<UserPresence | null> {
    return this.roomStore.updateSessionCursor(
      projectId,
      docId,
      socketId,
      cursor,
    );
  }

  public async applyDocUpdate(
    dto: SendUpdateDto,
    userId: string,
  ): Promise<DocUpdateResult> {
    const access = await this.verifyAccess(userId, dto.projectId);
    if (!access.canWrite) {
      throw new ForbiddenException(
        `User ${userId} lacks write permission for project ${dto.projectId}`,
      );
    }

    let nextLines: string[] | undefined = dto.lines;
    let serverRev = (dto.clientRev || 0) + 1;
    let version = (dto.clientRev || 0) + 1;
    let yjsFrame: Buffer | null = null;

    if (this.docstoreService && (dto.lines || dto.splice)) {
      if (this.yjsService) {
        await this.yjsService
          .flushDoc(dto.projectId, dto.docId)
          .catch(() => false);
      }
      const existing = await this.docstoreService.getDoc(
        dto.projectId,
        dto.docId,
      );
      if (!nextLines && dto.splice) {
        const cloned = [...(existing.lines || [])];
        cloned.splice(
          dto.splice.startLine,
          dto.splice.deleteCount,
          ...(dto.splice.newLines || []),
        );
        nextLines = cloned;
      }

      if (nextLines) {
        const updated = await this.docstoreService.updateDoc(
          dto.projectId,
          dto.docId,
          {
            lines: nextLines,
            version: (existing?.version ?? dto.clientRev ?? 0) + 1,
            expectedRev: existing?.rev,
          },
        );
        serverRev = updated.rev;
        version = updated.doc.version;
      }
    }

    if (nextLines && this.yjsService) {
      const { frame } = await this.yjsService.applyExternalTextAndSyncRedis(
        dto.projectId,
        dto.docId,
        nextLines.join('\n'),
      );
      yjsFrame = frame;
    }

    return {
      serverRev,
      clientRev: dto.clientRev,
      version,
      inFlightSeq: 1,
      yjsFrame,
    };
  }

  public async getProjectPresence(projectId: string): Promise<UserPresence[]> {
    return this.roomStore.getProjectSessions(projectId);
  }

  public async getDocPresence(
    projectId: string,
    docId: string,
  ): Promise<UserPresence[]> {
    return this.roomStore.getDocSessions(projectId, docId);
  }
}
