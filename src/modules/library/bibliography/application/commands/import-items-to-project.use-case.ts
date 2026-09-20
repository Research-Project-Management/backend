import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Inject,
  Logger,
} from '@nestjs/common';
import {
  PROJECT_ACCESS_PORT,
  IProjectAccessPort,
} from '../../domain/ports/project-access.port';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../../domain/ports/item-repository.port';
import { CreateItemUseCase } from './create-item.use-case';

export interface ImportItemsToProjectCommand {
  userId: string;
  projectId: string;
  itemIds: string[];
}

export interface ImportItemsToProjectResult {
  success: boolean;
  importedCount: number;
}

/**
 * Command Use Case — Import Items To Project
 *
 * Clean Architecture & DDD:
 * Depends strictly on Domain Ports (IProjectAccessPort, IItemRepositoryPort)
 * and CreateItemUseCase. Zero raw Prisma or concrete repository coupling.
 */
@Injectable()
export class ImportItemsToProjectUseCase {
  private readonly logger = new Logger(ImportItemsToProjectUseCase.name);

  constructor(
    @Inject(PROJECT_ACCESS_PORT)
    private readonly projectAccess: IProjectAccessPort,
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
    private readonly createItemUseCase: CreateItemUseCase,
  ) {}

  async execute(
    command: ImportItemsToProjectCommand,
  ): Promise<ImportItemsToProjectResult> {
    const { userId, projectId, itemIds } = command;

    if (!itemIds || itemIds.length === 0) {
      return { success: true, importedCount: 0 };
    }

    const hasAccess = await this.projectAccess.canAccessProject(
      userId,
      projectId,
    );
    if (!hasAccess) {
      throw new ForbiddenException(
        'You do not have permission to import items to this project',
      );
    }

    let importedCount = 0;

    for (const itemId of itemIds) {
      const source = await this.itemRepo.findById(userId, itemId);
      if (!source) continue;

      // Check if item already exists in target project
      const existingInProject = await this.itemRepo.findMany(userId, {
        projectId,
        search: source.doi || source.citationKey || source.title,
        limit: 10,
      });

      const isDuplicate = existingInProject.items.some(
        (it) =>
          (source.doi && it.doi === source.doi) ||
          (source.citationKey && it.citationKey === source.citationKey) ||
          it.title === source.title,
      );

      if (isDuplicate) {
        continue;
      }

      await this.createItemUseCase.execute({
        userId,
        projectId,
        title: source.title,
        itemType: source.itemType,
        doi: source.doi,
        citationKey: source.citationKey,
        abstract: source.abstract,
        year: source.year,
        publicationTitle: source.publicationTitle,
        fields: source.fields,
      });

      importedCount++;
    }

    return { success: true, importedCount };
  }
}
