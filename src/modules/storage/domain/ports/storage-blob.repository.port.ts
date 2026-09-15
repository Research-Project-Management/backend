import { StorageBlob } from '../entities/storage-blob.entity';
import { ContentHash } from '../value-objects/content-hash.vo';

export interface IStorageBlobRepository {
  findById(id: string): Promise<StorageBlob | null>;
  findByHash(contentHash: ContentHash): Promise<StorageBlob | null>;
  create(blob: StorageBlob): Promise<StorageBlob>;
  update(blob: StorageBlob): Promise<StorageBlob>;
  delete(id: string): Promise<void>;
  findTombstonedBlobs(threshold: Date, limit: number): Promise<StorageBlob[]>;
}
