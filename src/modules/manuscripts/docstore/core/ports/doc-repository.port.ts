/**
 * modules/manuscripts/docstore/core/ports/doc-repository.port.ts
 * Repository contract for Text Documents persistence with Optimistic Concurrency Control (OCC).
 */

import { TextDoc } from '../domain/text-doc.entity';
import { DocRanges } from '../domain/doc-range.vo';

export interface CreateDocData {
  projectId: string;
  path: string;
  lines: string[];
  version?: number;
  ranges?: DocRanges;
  hash?: string;
}

export interface UpdateDocData {
  lines: string[];
  version: number;
  ranges?: DocRanges;
  hash?: string;
  expectedRev?: number; // For Optimistic Concurrency Control (OCC)
}

export interface PatchDocData {
  deleted?: boolean;
  name?: string;
  deletedAt?: Date | null;
}

export abstract class IDocRepository {
  abstract getDoc(projectId: string, docId: string): Promise<TextDoc | null>;
  abstract getDocByPath(projectId: string, path: string): Promise<TextDoc | null>;
  abstract getAllDocs(projectId: string): Promise<TextDoc[]>;
  abstract getAllDeletedDocs(projectId: string): Promise<TextDoc[]>;
  abstract createDoc(data: CreateDocData): Promise<TextDoc>;
  abstract updateDoc(projectId: string, docId: string, data: UpdateDocData): Promise<{ doc: TextDoc; modified: boolean }>;
  abstract patchDoc(projectId: string, docId: string, patch: PatchDocData): Promise<TextDoc>;
  abstract markAsArchived(projectId: string, docId: string, storageKey: string, rev: number): Promise<void>;
  abstract unarchiveDoc(projectId: string, docId: string, lines: string[], ranges?: DocRanges): Promise<TextDoc>;
  abstract destroyDoc(projectId: string, docId: string): Promise<boolean>;
  abstract destroyAllDocs(projectId: string): Promise<number>;
}
