export const FILES_PORT = Symbol('FILES_PORT');

export const STORAGE_ADAPTER = Symbol('STORAGE_ADAPTER');

export const FILES_MAINTENANCE_QUEUE = 'files-maintenance';
export const FILES_MEDIA_QUEUE = 'files-media';
export const FILES_FINALIZE_CAS_QUEUE = 'files-finalize-cas';
export const FILES_JOB_CLEANUP_EXPIRED_SESSIONS =
  'files-cleanup-expired-sessions';
export const FILES_JOB_RECLAIM_ORPHAN_BLOBS = 'files-reclaim-orphan-blobs';
export const FILES_JOB_RECONCILE_QUOTAS = 'files-reconcile-quotas';
export const FILES_JOB_GENERATE_THUMBNAIL = 'files-generate-thumbnail';
export const FILES_JOB_PROMOTE_CAS = 'files-promote-cas';
export const FILES_JOB_DELETE_STAGING_OBJECT = 'files-delete-staging-object';
export const FILES_JOB_RECOVER_STALE_FINALIZING =
  'files-recover-stale-finalizing';
export const FILES_JOB_SWEEP_STAGING_BLOBS = 'files-sweep-staging-blobs';

export const DEFAULT_STORAGE_QUOTA_BYTES = 5n * 1024n * 1024n * 1024n; // 5 GB
export const DEFAULT_PRESIGN_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_PDF_THUMBNAIL_BYTES = 25n * 1024n * 1024n; // 25 MB

export const MIN_MULTIPART_PART_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB S3 minimum
export const MULTIPART_MEDIUM_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100 MB
export const MULTIPART_LARGE_THRESHOLD_BYTES = 1024 * 1024 * 1024; // 1 GB
export const MULTIPART_MEDIUM_PART_SIZE_BYTES = 16 * 1024 * 1024; // 16 MB
export const MULTIPART_LARGE_PART_SIZE_BYTES = 64 * 1024 * 1024; // 64 MB
export const MAX_MULTIPART_PARTS = 8000;
export const MAX_PART_PRESIGN_BATCH = 50;
export const DEFAULT_STAGING_TTL_SECONDS = 300;
export const DEFAULT_MULTIPART_TTL_HOURS = 24;
export const DEFAULT_STAGING_LIFECYCLE_DAYS = 3;
export const STAGING_DELETE_DELAY_MS = 15 * 60 * 1000;
export const STALE_FINALIZING_LEASE_MINUTES = 5;
export const STAGING_SWEEP_MIN_AGE_MINUTES = 5;
export const PRESIGN_COMPLETE_IDEM_TTL_SECONDS = 600;
export const MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER = 20;
export const GC_CLAIM_LEASE_MINUTES = 30;
export const MAX_CONCURRENT_THUMBNAIL_RENDERS = 2;
export const MAX_CONCURRENT_CAS_PROMOTIONS = 2;

export const PUBLIC_OBJECT_ALLOWLIST_PREFIXES = [
  'public/',
  'avatars/',
  'icons/',
] as const;

export const SIGNED_OBJECT_PREFIXES = ['thumbnails/', 'derivatives/'] as const;
