import { Injectable, Logger, Optional, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/core';
import { DocumentUpdaterService } from '@/modules/manuscripts/document-updater/document-updater.service';
import { RoomStore } from './room.store';
import { UserPresence, CursorPosition } from './types/presence.type';
import { SendUpdateDto } from './dto/events.dto';

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
}

@Injectable()
export class ManuscriptsService {
  private readonly logger = new Logger(ManuscriptsService.name);

  constructor(
    private readonly roomStore: RoomStore,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly docUpdater?: DocumentUpdaterService,
  ) {}

  public async verifyAccess(
    userId: string,
    projectId: string,
  ): Promise<ProjectAccess> {
    if (!this.prisma) {
      return { canRead: true, canWrite: true, role: 'contributor' };
    }

    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      !projectId ||
      !userId ||
      !uuidRegex.test(projectId) ||
      !uuidRegex.test(userId)
    ) {
      return { canRead: false, canWrite: false, role: 'none' };
    }

    try {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { createdById: true },
      });

      if (!project) {
        return { canRead: false, canWrite: false, role: 'none' };
      }

      if (project.createdById === userId) {
        return { canRead: true, canWrite: true, role: 'owner' };
      }

      const member = await this.prisma.projectMember.findUnique({
        where: {
          projectId_userId: { projectId, userId },
        },
        select: { role: true },
      });

      if (!member) {
        return { canRead: false, canWrite: false, role: 'none' };
      }

      const isReviewer = member.role === 'reviewer';
      return {
        canRead: true,
        canWrite: !isReviewer,
        role: member.role,
      };
    } catch (err) {
      this.logger.warn(`Error verifying project access: ${err}`);
      return { canRead: false, canWrite: false, role: 'none' };
    }
  }

  public async joinProject(input: {
    projectId: string;
    userId: string;
    socketId: string;
    name?: string | null;
    color?: string | null;
    avatar?: string | null;
  }): Promise<{ session: UserPresence; projectPresence: UserPresence[]; access: ProjectAccess }> {
    const { projectId, userId, socketId, name, color, avatar } = input;

    const access = await this.verifyAccess(userId, projectId);
    if (!access.canRead) {
      throw new ForbiddenException(`User ${userId} lacks permission to access project ${projectId}`);
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
      throw new NotFoundException(`Session ${socketId} not found in project ${projectId}`);
    }

    const docPresence = await this.roomStore.joinDocRoom(projectId, docId, socketId);
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
    return this.roomStore.updateSessionCursor(projectId, docId, socketId, cursor);
  }

  public async applyDocUpdate(
    dto: SendUpdateDto,
    userId: string,
  ): Promise<DocUpdateResult> {
    const access = await this.verifyAccess(userId, dto.projectId);
    if (!access.canWrite) {
      throw new ForbiddenException(`User ${userId} lacks write permission for project ${dto.projectId}`);
    }

    if (this.docUpdater) {
      const res = await this.docUpdater.queueUpdate(dto.projectId, dto.docId, {
        lines: dto.lines,
        splice: dto.splice,
        clientRev: dto.clientRev,
        userId,
        debounceMs: dto.debounceMs,
      });

      return {
        serverRev: res.rev,
        clientRev: dto.clientRev,
        version: res.inFlightSeq,
        inFlightSeq: res.inFlightSeq,
      };
    }

    // Fallback if docUpdater is not loaded (test environment)
    return {
      serverRev: dto.clientRev + 1,
      clientRev: dto.clientRev,
      version: 1,
      inFlightSeq: 1,
    };
  }

  public async getProjectPresence(projectId: string): Promise<UserPresence[]> {
    return this.roomStore.getProjectSessions(projectId);
  }

  public async getDocPresence(projectId: string, docId: string): Promise<UserPresence[]> {
    return this.roomStore.getDocSessions(projectId, docId);
  }
}
