import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { StateRepository } from './state.repository';
import { UpdateStateDto, StateResponse } from './dto/state.dto';

@Injectable()
export class StateService {
  private readonly logger = new Logger(StateService.name);

  constructor(private readonly stateRepo: StateRepository) {}

  private toResponse(
    state?: {
      readStatus: string;
      rating: number | null;
      lastReadAt: Date | null;
    } | null,
  ): StateResponse {
    return {
      readStatus:
        (state?.readStatus as 'unread' | 'reading' | 'completed') ?? 'unread',
      rating: state?.rating ?? 0,
      lastReadAt: state?.lastReadAt ? state.lastReadAt.toISOString() : null,
    };
  }

  async getState(
    workspaceId: string,
    paramA: string,
    paramB: string,
  ): Promise<StateResponse> {
    const { itemId, userId } = await this.resolveItemAndUser(
      workspaceId,
      paramA,
      paramB,
    );
    const state = await this.stateRepo.findState(workspaceId, itemId, userId);
    return this.toResponse(state);
  }

  async updateState(
    workspaceId: string,
    paramA: string,
    paramB: string,
    dto: UpdateStateDto,
  ): Promise<StateResponse> {
    const { itemId, userId } = await this.resolveItemAndUser(
      workspaceId,
      paramA,
      paramB,
    );

    const updated = await this.stateRepo.upsertState(
      workspaceId,
      itemId,
      userId,
      {
        readStatus: dto.readStatus,
        rating: dto.rating,
      },
    );

    return this.toResponse(updated);
  }

  async markAsRead(
    workspaceId: string,
    paramA: string,
    paramB: string,
  ): Promise<StateResponse> {
    const { itemId, userId } = await this.resolveItemAndUser(
      workspaceId,
      paramA,
      paramB,
    );

    const existing = await this.stateRepo.findState(
      workspaceId,
      itemId,
      userId,
    );
    const nextStatus =
      existing?.readStatus === 'completed'
        ? ('completed' as any)
        : ('reading' as any);

    const updated = await this.stateRepo.upsertState(
      workspaceId,
      itemId,
      userId,
      {
        readStatus: nextStatus,
        lastReadAt: new Date(),
      },
    );

    return this.toResponse(updated);
  }

  private async resolveItemAndUser(
    workspaceId: string,
    paramA: string,
    paramB: string,
  ): Promise<{ itemId: string; userId: string }> {
    let item = await this.stateRepo.findItemInWorkspace(workspaceId, paramA);
    if (item) {
      return { itemId: paramA, userId: paramB };
    }
    item = await this.stateRepo.findItemInWorkspace(workspaceId, paramB);
    if (item) {
      return { itemId: paramB, userId: paramA };
    }
    throw new NotFoundException(
      `Item not found in workspace ${workspaceId}`,
    );
  }

  async getBatchStates(
    workspaceId: string,
    itemIds: string[],
    userId: string,
  ): Promise<Record<string, StateResponse>> {
    if (!itemIds.length) return {};

    const states = await this.stateRepo.findStatesForItems(
      workspaceId,
      itemIds,
      userId,
    );

    const resultMap: Record<string, StateResponse> = {};
    for (const id of itemIds) {
      resultMap[id] = this.toResponse(null);
    }

    for (const st of states) {
      resultMap[st.itemId] = this.toResponse(st);
    }

    return resultMap;
  }
}
