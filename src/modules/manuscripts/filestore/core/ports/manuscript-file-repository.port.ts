/**
 * filestore/core/ports/manuscript-file-repository.port.ts
 * Outbound Port (SPI) for Database Persistence of ManuscriptFile metadata.
 */

import { ManuscriptFile } from '../domain/entities/manuscript-file.entity';

export abstract class IManuscriptFileRepository {
  abstract save(file: ManuscriptFile): Promise<ManuscriptFile>;
  abstract findById(id: string): Promise<ManuscriptFile | null>;
  abstract findByProjectAndId(projectId: string, id: string): Promise<ManuscriptFile | null>;
  abstract findByProjectAndName(projectId: string, name: string): Promise<ManuscriptFile | null>;
  abstract findByHash(hash: string): Promise<ManuscriptFile[]>;
  abstract listByProject(projectId: string, includeDeleted?: boolean): Promise<ManuscriptFile[]>;
  abstract delete(id: string): Promise<void>;
  abstract countReferencesByHash(hash: string): Promise<number>;
}
