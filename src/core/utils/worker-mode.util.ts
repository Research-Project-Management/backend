/**
 * Utility determining whether background queue consumers should be registered in the current process.
 *
 * Rules:
 * 1. WORKER_MODE === 'true': Dedicated worker process -> Always true.
 * 2. ENABLE_IN_PROCESS_WORKERS === 'false': Explicitly disabled for Web API pods -> False.
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
