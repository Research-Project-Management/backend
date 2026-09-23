/**
 * filestore/dto/file-response.dto.ts
 */

import { ManuscriptFile } from '../core/domain/entities/manuscript-file.entity';

export class ManuscriptFileResponseDto {
  id!: string;
  projectId!: string;
  name!: string;
  mimeType!: string;
  sizeBytes!: number;
  hash!: string;
  storageKey!: string;
  bucketName!: string;
  rev!: number;
  createdAt!: string;
  updatedAt!: string;

  public static fromEntity(entity: ManuscriptFile): ManuscriptFileResponseDto {
    const dto = new ManuscriptFileResponseDto();
    dto.id = entity.id;
    dto.projectId = entity.projectId;
    dto.name = entity.name;
    dto.mimeType = entity.mimeType;
    dto.sizeBytes = entity.sizeBytes;
    dto.hash = entity.hash.getValue();
    dto.storageKey = entity.storageKey.getValue();
    dto.bucketName = entity.bucketName;
    dto.rev = entity.rev;
    dto.createdAt = entity.createdAt.toISOString();
    dto.updatedAt = entity.updatedAt.toISOString();
    return dto;
  }
}
