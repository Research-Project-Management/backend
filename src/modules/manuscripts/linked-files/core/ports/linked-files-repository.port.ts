/**
 * linked-files/core/ports/linked-files-repository.port.ts
 * Driven port interface for Linked Files persistent storage.
 */

import { LinkedFileEntity } from '../domain/entities/linked-file.entity';

export abstract class ILinkedFilesRepositoryPort {
  abstract save(entity: LinkedFileEntity): Promise<LinkedFileEntity>;
  abstract findById(
    projectId: string,
    id: string,
  ): Promise<LinkedFileEntity | null>;
  abstract findByProject(projectId: string): Promise<LinkedFileEntity[]>;
  abstract findByNodeId(
    projectId: string,
    nodeId: string,
  ): Promise<LinkedFileEntity | null>;
  abstract findAllAutoRefresh(): Promise<LinkedFileEntity[]>;
  abstract delete(projectId: string, id: string): Promise<boolean>;
}
