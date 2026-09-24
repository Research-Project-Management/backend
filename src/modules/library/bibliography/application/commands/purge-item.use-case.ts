import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../../domain/ports/item-repository.port';
import {
  PROJECT_ACCESS_PORT,
  IProjectAccessPort,
} from '../../domain/ports/project-access.port';
import { TagsService } from '../services/tags.service';

export interface PurgeItemCommand {
  userId: string;
  itemId: string;
  projectId?: string;
}

@Injectable()
export class PurgeItemUseCase {
  private readonly logger = new Logger(PurgeItemUseCase.name);

  constructor(
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
    private readonly tagsService: TagsService,
    @Optional()
    @Inject(PROJECT_ACCESS_PORT)
    private readonly projectAccessPort?: IProjectAccessPort,
  ) {}

  async execute(command: PurgeItemCommand): Promise<boolean> {
    const { userId, itemId, projectId } = command;
    this.logger.log(`Purging item ${itemId} for user ${userId}`);

    const existing = await this.itemRepo.findById(
      userId,
      itemId,
      projectId,
      true,
    );
    if (!existing) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }

    if (existing.projectId) {
      if (!projectId || projectId !== existing.projectId) {
        throw new ForbiddenException(
          'Project context matching item is required to permanently purge project items',
        );
      }
      if (this.projectAccessPort) {
        const isOwner = await this.projectAccessPort.isProjectOwner(
          userId,
          existing.projectId,
        );
        if (!isOwner) {
          throw new ForbiddenException(
            'Only project owners can permanently purge items belonging to a project',
          );
        }
      }
    }

    const purged = await this.itemRepo.purge(userId, itemId, projectId);
    await this.tagsService.invalidateTagsCache(userId, projectId);
    return purged;
  }
}
