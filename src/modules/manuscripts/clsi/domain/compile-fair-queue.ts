/**
 * modules/manuscripts/clsi/domain/compile-fair-queue.ts
 * Clean Architecture bridge:
 * - Pure Domain logic resides at `./fair-semaphore.domain`.
 * - Application Orchestration Service resides at `../services/compile-fair-queue.service`.
 */

export * from './fair-semaphore.domain';
export {
  CompileFairQueue,
  type InFlightCompileSession,
  type CompileQueueConfig,
} from '../services/compile-fair-queue.service';
