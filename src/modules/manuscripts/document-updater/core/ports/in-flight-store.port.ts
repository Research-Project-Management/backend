/**
 * document-updater/core/ports/in-flight-store.port.ts
 * Outbound Port (SPI) for storing active in-flight document buffers in fast memory or Redis.
 */

import { InFlightDoc } from '../domain/entities/in-flight-doc.entity';

export abstract class IInFlightStorePort {
  /**
   * Retrieves an in-flight document buffer by project and document ID.
   */
  abstract get(projectId: string, docId: string): Promise<InFlightDoc | null>;

  /**
   * Saves or updates an in-flight document buffer.
   */
  abstract save(doc: InFlightDoc): Promise<void>;

  /**
   * Removes an in-flight document buffer from memory/Redis (e.g. on clean evict).
   */
  abstract delete(projectId: string, docId: string): Promise<void>;

  /**
   * Returns all dirty document IDs for a given project.
   */
  abstract getDirtyDocIds(projectId: string): Promise<string[]>;

  /**
   * Returns all project IDs currently having in-flight buffers.
   */
  abstract getAllProjectIds(): Promise<string[]>;

  /**
   * Clears all in-flight buffers (used during tests or maintenance flush).
   */
  abstract clear(): Promise<void>;
}
