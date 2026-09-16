import { StorageVersion } from '../entities/storage-version.entity';

export interface IStorageVersionRepository {
  create(version: StorageVersion): Promise<StorageVersion>;
  findByFileId(fileId: string): Promise<StorageVersion[]>;
  findByFileAndVersion(
    fileId: string,
    versionNumber: number,
  ): Promise<StorageVersion | null>;
  getLatestVersionNumber(fileId: string): Promise<number>;
  deleteByFileId(fileId: string): Promise<void>;
}
