export const STORAGE_PROCESSING_QUEUE = 'storage-processing';

export const STORAGE_JOB_PROCESS_FILE = 'process-file';
export const STORAGE_JOB_MAINTENANCE_TRASH = 'maintenance-trash-retention';
export const STORAGE_JOB_MAINTENANCE_MULTIPART =
  'maintenance-multipart-cleanup';
export const STORAGE_JOB_MAINTENANCE_ORPHAN = 'maintenance-orphan-blob';

export interface StorageProcessingJobData {
  fileId: string;
  blobId: string;
  s3Key: string;
  mimeType: string;
  filename: string;
  userId: string;
  projectId?: string | null;
}
