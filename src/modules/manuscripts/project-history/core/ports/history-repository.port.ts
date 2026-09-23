/**
 * project-history/core/ports/history-repository.port.ts
 * Outbound Port (SPI) for persisting and querying snapshots and version labels in PostgreSQL.
 */

import { Snapshot } from '../domain/entities/snapshot.entity';
import { VersionLabel } from '../domain/entities/version-label.entity';

export abstract class IHistoryRepositoryPort {
  /**
   * Persists a new snapshot record and its attached labels.
   */
  abstract saveSnapshot(snapshot: Snapshot): Promise<Snapshot>;

  /**
   * Retrieves a snapshot by project and version number.
   */
  abstract findByVersion(projectId: string, version: number): Promise<Snapshot | null>;

  /**
   * Returns the highest version number recorded for this project (returns 0 if no snapshots exist).
   */
  abstract getLatestVersion(projectId: string): Promise<number>;

  /**
   * Lists all version snapshots for a project ordered by version ascending.
   */
  abstract listVersions(projectId: string): Promise<Snapshot[]>;

  /**
   * Saves or updates a version label.
   */
  abstract saveLabel(label: VersionLabel): Promise<VersionLabel>;

  /**
   * Deletes a version label by ID.
   */
  abstract deleteLabel(projectId: string, labelId: string): Promise<void>;

  /**
   * Finds a label by project and label string.
   */
  abstract findLabelByName(projectId: string, label: string): Promise<VersionLabel | null>;
}
