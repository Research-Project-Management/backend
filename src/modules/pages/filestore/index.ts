/**
 * modules/pages/filestore/index.ts
 * Public interface for the Pages Filestore subsystem.
 */

export { IBinaryStoragePort } from './domain/filestore.ports';
export {
  PageBinaryAsset,
  ContentHash,
  StorageKey,
  ByteRange,
  type CreatePageBinaryAssetProps,
} from './domain/file.entity';
export {
  MAX_FILE_SIZE_BYTES,
  FileNotFoundException,
  InvalidByteRangeException,
  DuplicateFileException,
  StorageQuotaExceededException,
  FilestoreValidationException,
} from './domain/filestore.errors';
export { PageBinaryAssetResponseDto } from './dto/file-response.dto';
export type {
  StorageUploadOptions,
  StorageRangeOptions,
  StorageObjectMetadata,
  StreamHashResult,
  StreamPageBinaryAssetOutput,
  GetFileHeadOutput,
} from './types/filestore.types';
export {
  FilestoreRepository,
  PageBinaryAssetMapper,
  ContentHasherAdapter,
  PlatformBinaryStorageAdapter,
  LocalDiskBinaryStorageAdapter,
} from './filestore.repository';
export { FilestoreService } from './filestore.service';
export { FilestoreModule } from './filestore.module';
