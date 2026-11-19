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

export type ServicePlaneMode = 'all' | 'experiments' | 'transfer' | 'worker';

/**
 * Determines which service plane the current process is serving.
 * - Defaults to 'worker' if WORKER_MODE === 'true' and SERVICE_PLANE is not set.
 * - Defaults to 'all' for standard monolith / hybrid deployments.
 */
export function getServicePlaneMode(): ServicePlaneMode {
  const raw = (process.env.SERVICE_PLANE || '').trim().toLowerCase();
  if (
    raw === 'experiments' ||
    raw === 'transfer' ||
    raw === 'worker' ||
    raw === 'all'
  ) {
    return raw;
  }
  if (process.env.WORKER_MODE === 'true') {
    return 'worker';
  }
  return 'all';
}

/**
 * Whether Experiments HTTP controllers (Experiments, Trash, Version) should be mounted.
 */
export function shouldMountExperimentsControllers(): boolean {
  const plane = getServicePlaneMode();
  return plane === 'all' || plane === 'experiments';
}

/**
 * Whether Data-Plane HTTP controllers (Upload, Stream/Download, Files) should be mounted.
 */
export function shouldMountTransferControllers(): boolean {
  const plane = getServicePlaneMode();
  return plane === 'all' || plane === 'transfer';
}
