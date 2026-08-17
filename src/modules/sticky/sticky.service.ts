import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { StickyRepository, StickyWithUser } from './sticky.repository';
import { CreateStickyDto, UpdateStickyDto } from './dto/sticky.dto';
import { StickyScope } from '@prisma/client';

@Injectable()
export class StickyService {
  constructor(private readonly stickyRepo: StickyRepository) {}

  private formatSticky(s: StickyWithUser): StickyWithUser & {
    position: { x: number; y: number };
  };
  private formatSticky(s: null | undefined): null;
  private formatSticky(s: StickyWithUser | null | undefined):
    | (StickyWithUser & {
        position: { x: number; y: number };
      })
    | null;
  private formatSticky(s: StickyWithUser | null | undefined) {
    if (!s) return null;
    return {
      ...s,
      position: { x: s.positionX, y: s.positionY },
    };
  }

  async getWorkspaceStickies(workspaceId: string, userId: string) {
    const stickies = await this.stickyRepo.findWorkspaceStickies(
      workspaceId,
      userId,
    );
    return { stickies: stickies.map((s) => this.formatSticky(s)) };
  }

  async getProjectStickies(projectId: string, userId: string) {
    const stickies = await this.stickyRepo.findProjectStickies(
      projectId,
      userId,
    );
    return { stickies: stickies.map((s) => this.formatSticky(s)) };
  }

  async createWorkspaceSticky(
    workspaceId: string,
    userId: string,
    dto: CreateStickyDto,
  ) {
    const count = await this.stickyRepo.countWorkspaceStickies(
      workspaceId,
      userId,
    );

    const sticky = await this.stickyRepo.createSticky({
      title: dto.title || '',
      content: dto.content,
      color: dto.color || 'yellow-1',
      scope: StickyScope.workspace,
      positionX: dto.position?.x ?? 0,
      positionY: dto.position?.y ?? 0,
      order: count,
      workspaceId,
      userId,
    });

    return { sticky: this.formatSticky(sticky) };
  }

  async createProjectSticky(
    projectId: string,
    userId: string,
    dto: CreateStickyDto,
  ) {
    let workspaceId = '';
    const wsId = await this.stickyRepo.findProjectWorkspaceId(projectId);
    if (wsId) {
      workspaceId = wsId;
    }

    const count = await this.stickyRepo.countProjectStickies(projectId, userId);

    const sticky = await this.stickyRepo.createSticky({
      title: dto.title || '',
      content: dto.content,
      color: dto.color || 'yellow-1',
      scope: StickyScope.project,
      positionX: dto.position?.x ?? 0,
      positionY: dto.position?.y ?? 0,
      order: count,
      workspaceId,
      projectId,
      userId,
    });

    return { sticky: this.formatSticky(sticky) };
  }

  async updateSticky(stickyId: string, userId: string, dto: UpdateStickyDto) {
    const existing = await this.stickyRepo.findStickyById(stickyId);
    if (!existing) {
      throw new NotFoundException('Sticky note not found');
    }
    if (existing.userId !== userId) {
      throw new ForbiddenException('You can only update your own sticky notes');
    }

    const sticky = await this.stickyRepo.updateSticky(stickyId, {
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.content !== undefined && { content: dto.content }),
      ...(dto.color !== undefined && { color: dto.color }),
      ...(dto.scope !== undefined && { scope: dto.scope }),
      ...(dto.position?.x !== undefined && { positionX: dto.position.x }),
      ...(dto.position?.y !== undefined && { positionY: dto.position.y }),
      ...(dto.projectId !== undefined && { projectId: dto.projectId }),
    });

    return { sticky: this.formatSticky(sticky) };
  }

  async deleteSticky(stickyId: string, userId: string) {
    const existing = await this.stickyRepo.findStickyById(stickyId);
    if (!existing) {
      throw new NotFoundException('Sticky note not found');
    }
    if (existing.userId !== userId) {
      throw new ForbiddenException('You can only delete your own sticky notes');
    }

    await this.stickyRepo.deleteSticky(stickyId);
    return { message: 'Sticky deleted successfully', success: true };
  }

  async reorderStickies(stickyIds: string[]) {
    if (!stickyIds || stickyIds.length <= 1) {
      return { success: true };
    }
    await this.stickyRepo.reorderStickies(stickyIds);
    return { success: true };
  }
}
