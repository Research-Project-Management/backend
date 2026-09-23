/**
 * document-updater/core/adapters/storage/in-memory-in-flight-store.adapter.ts
 * Driven Adapter implementing IInFlightStorePort with fast in-memory maps.
 * Used for development and unit testing without requiring external infrastructure.
 */

import { Injectable } from '@nestjs/common';
import { IInFlightStorePort } from '../../ports/in-flight-store.port';
import { InFlightDoc } from '../../domain/entities/in-flight-doc.entity';

@Injectable()
export class InMemoryInFlightStoreAdapter extends IInFlightStorePort {
  // Key format: `${projectId}:${docId}`
  private readonly docs = new Map<string, InFlightDoc>();
  // Project dirty doc tracking: projectId -> Set<docId>
  private readonly dirtyDocs = new Map<string, Set<string>>();

  private toKey(projectId: string, docId: string): string {
    return `${projectId}:${docId}`;
  }

  public async get(projectId: string, docId: string): Promise<InFlightDoc | null> {
    return this.docs.get(this.toKey(projectId, docId)) ?? null;
  }

  public async save(doc: InFlightDoc): Promise<void> {
    const key = this.toKey(doc.projectId, doc.docId);
    this.docs.set(key, doc);

    let projectDirtySet = this.dirtyDocs.get(doc.projectId);
    if (!projectDirtySet) {
      projectDirtySet = new Set<string>();
      this.dirtyDocs.set(doc.projectId, projectDirtySet);
    }

    if (doc.isDirty) {
      projectDirtySet.add(doc.docId);
    } else {
      projectDirtySet.delete(doc.docId);
    }
  }

  public async delete(projectId: string, docId: string): Promise<void> {
    const key = this.toKey(projectId, docId);
    this.docs.delete(key);
    this.dirtyDocs.get(projectId)?.delete(docId);
  }

  public async getDirtyDocIds(projectId: string): Promise<string[]> {
    const dirtySet = this.dirtyDocs.get(projectId);
    if (!dirtySet) return [];
    return Array.from(dirtySet);
  }

  public async getAllProjectIds(): Promise<string[]> {
    const projectIds = new Set<string>();
    for (const doc of this.docs.values()) {
      projectIds.add(doc.projectId);
    }
    return Array.from(projectIds);
  }

  public async clear(): Promise<void> {
    this.docs.clear();
    this.dirtyDocs.clear();
  }
}
