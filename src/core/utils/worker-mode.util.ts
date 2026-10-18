/**
 * Utility determining whether background queue consumers should be registered in the current process.
 *
 * Rules:
 * 1. WORKER_MODE === 'true': Dedicated worker process -> Always true.
 * 2. ENABLE_IN_PROCESS_WORKERS === 'false': Explicitly disabled for Web API containers -> False.
 * 3. ENABLE_IN_PROCESS_WORKERS === 'true': Explicitly enabled -> True.
 * 4. Default in development (process.env.NODE_ENV !== 'production'): True (for hybrid single-process DX).
 * 5. Default in production (process.env.NODE_ENV === 'production'): False (Web API and Workers MUST be separated).
 */
export function shouldRunWorkerConsumers(): boolean {
  if (process.env.WORKER_MODE === 'true') {
    return true;
  }
  if (process.env.ENABLE_IN_PROCESS_WORKERS === 'false') {
    return false;
  }
  if (process.env.ENABLE_IN_PROCESS_WORKERS === 'true') {
    return true;
  }
  return process.env.NODE_ENV !== 'production';
}

export type StoragePlaneMode = 'all' | 'drive' | 'transfer' | 'worker';

/**
 * Determines which storage plane the current process is serving.
 * - Defaults to 'worker' if WORKER_MODE === 'true' and STORAGE_PLANE is not set.
 * - Defaults to 'all' for standard monolith / hybrid deployments.
 */
export function getStoragePlaneMode(): StoragePlaneMode {
  const raw = (process.env.STORAGE_PLANE || '').trim().toLowerCase();
  if (raw === 'drive' || raw === 'transfer' || raw === 'worker' || raw === 'all') {
    return raw;
  }
  if (process.env.WORKER_MODE === 'true') {
    return 'worker';
  }
  return 'all';
}

/**
 * Whether Control-Plane HTTP controllers (Drive, Trash, Quota, Version) should be mounted.
 */
export function shouldMountDriveControllers(): boolean {
  const plane = getStoragePlaneMode();
  return plane === 'all' || plane === 'drive';
}

/**
 * Whether Data-Plane HTTP controllers (Upload, Stream/Download) should be mounted.
 */
export function shouldMountTransferControllers(): boolean {
  const plane = getStoragePlaneMode();
  return plane === 'all' || plane === 'transfer';
}

