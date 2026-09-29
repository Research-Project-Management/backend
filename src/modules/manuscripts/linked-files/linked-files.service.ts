/**
 * linked-files/linked-files.service.ts
 * Module Façade orchestrating Linked Files use cases.
 */

import { Injectable, Logger } from '@nestjs/common';
import { CreateLinkedFileUseCase } from './core/use-cases/create-linked-file.use-case';
import { RefreshLinkedFileUseCase } from './core/use-cases/refresh-linked-file.use-case';
import { ListLinkedFilesUseCase } from './core/use-cases/list-linked-files.use-case';
import { DeleteLinkedFileUseCase } from './core/use-cases/delete-linked-file.use-case';
import { ILinkedFilesRepositoryPort } from './core/ports/linked-files-repository.port';
import {
  CreateLinkedFileDto,
  LinkedFileResponseDto,
} from './dto/linked-file.dto';
import { LinkedFileEntity } from './core/domain/entities/linked-file.entity';

@Injectable()
export class LinkedFilesService {
  private readonly logger = new Logger(LinkedFilesService.name);

  constructor(
    private readonly createLinkedFileUseCase: CreateLinkedFileUseCase,
    private readonly refreshLinkedFileUseCase: RefreshLinkedFileUseCase,
    private readonly listLinkedFilesUseCase: ListLinkedFilesUseCase,
    private readonly deleteLinkedFileUseCase: DeleteLinkedFileUseCase,
    private readonly repository: ILinkedFilesRepositoryPort,
  ) {}

  public async create(
    projectId: string,
    dto: CreateLinkedFileDto,
    userId?: string,
  ): Promise<LinkedFileResponseDto> {
    const entity = await this.createLinkedFileUseCase.execute(
      projectId,
      dto,
      userId,
    );
    return this.mapToDto(entity);
  }

  public async refresh(
    projectId: string,
    id: string,
    userId?: string,
  ): Promise<LinkedFileResponseDto> {
    const entity = await this.refreshLinkedFileUseCase.execute(
      projectId,
      id,
      userId,
    );
    return this.mapToDto(entity);
  }

  public async list(projectId: string): Promise<LinkedFileResponseDto[]> {
    const entities = await this.listLinkedFilesUseCase.execute(projectId);
    return entities.map((e) => this.mapToDto(e));
  }

  public async delete(
    projectId: string,
    id: string,
    deleteNode = false,
  ): Promise<void> {
    await this.deleteLinkedFileUseCase.execute(projectId, id, deleteNode);
  }

  /**
   * Refreshes all linked files with autoRefresh enabled.
   * Called by background workers or schedulers.
   */
  public async refreshAllAutoRefresh(): Promise<{
    total: number;
    succeeded: number;
    failed: number;
  }> {
    const autoFiles = await this.repository.findAllAutoRefresh();
    let succeeded = 0;
    let failed = 0;

    for (const item of autoFiles) {
      try {
        await this.refreshLinkedFileUseCase.execute(item.projectId, item.id);
        succeeded++;
      } catch (err: any) {
        failed++;
        this.logger.warn(
          `Auto-refresh failed for linked file ${item.id} (${item.name}): ${err?.message}`,
        );
      }
    }

    return { total: autoFiles.length, succeeded, failed };
  }

  private mapToDto(entity: LinkedFileEntity): LinkedFileResponseDto {
    return {
      id: entity.id,
      projectId: entity.projectId,
      name: entity.name,
      provider: entity.provider,
      url: entity.url,
      collectionId: entity.collectionId,
      nodeId: entity.nodeId,
      docId: entity.docId,
      fileId: entity.fileId,
      status: entity.status,
      lastSyncedAt: entity.lastSyncedAt?.toISOString() ?? null,
      errorMessage: entity.errorMessage,
      autoRefresh: entity.autoRefresh,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }
}
