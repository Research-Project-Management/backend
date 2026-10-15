/**
 * document-updater/core/adapters/storage/redis-in-flight-store.adapter.ts
 * Backward-compatible re-export of DocumentUpdaterRepository.
 */

export {
  DocumentUpdaterRepository,
  DocumentUpdaterRepository as RedisInFlightStoreAdapter,
} from '@/modules/manuscripts/document-updater/document-updater.repository';
