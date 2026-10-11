/**
 * git-bridge/core/use-cases/git-sync.use-case.ts
 *
 * Bidirectional sync between the project (Structure tree + Docstore +
 * Filestore) and the per-project bare Git repository:
 *  - materialize(): flushes live editing sessions, then commits the current
 *    project snapshot on `main` (no-op when unchanged).
 *  - applyPush(): applies the diff between two commits back into the project,
 *    soft-deleting (never purging) removed docs/files.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Readable } from 'stream';
import { DocstoreService } from '../../../docstore/docstore.service';
import { FilestoreService } from '../../../filestore/filestore.service';
import { StructureService } from '../../../structure/structure.service';
import { LiveCollaborationPort } from '../../../docstore/core/ports/live-collaboration.port';
import { GitCliAdapter } from '../adapters/git-cli.adapter';
import {
  GitChange,
  isTextPath,
  parseNameStatusZ,
  toProjectPath,
  toRepoPath,
} from '../domain/git-bridge.domain';

export interface PushApplyResult {
  created: string[];
  updated: string[];
  deleted: string[];
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

@Injectable()
export class GitSyncUseCase {
  private readonly logger = new Logger(GitSyncUseCase.name);
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly git: GitCliAdapter,
    private readonly docstore: DocstoreService,
    private readonly filestore: FilestoreService,
    private readonly structure: StructureService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  /** Serializes all repo operations per project (in-process mutex). */
  withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(projectId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    this.locks.set(projectId, tail);
    void tail.then(() => {
      if (this.locks.get(projectId) === tail) this.locks.delete(projectId);
    });
    return next;
  }

  private live(): LiveCollaborationPort | null {
    try {
      return this.moduleRef?.get(LiveCollaborationPort, { strict: false }) ?? null;
    } catch {
      return null;
    }
  }

  /** Commits the current project state to `main`; returns tip sha. Caller holds lock. */
  async materialize(projectId: string): Promise<string> {
    await this.git.ensureRepo(projectId);
    const nodes = await this.structure.getAllNodes(projectId);

    const live = this.live();
    if (live) {
      const docIds = nodes.filter((n) => n.docId).map((n) => n.docId as string);
      await live.flushDocs(projectId, docIds).catch((e) =>
        this.logger.warn(`Live flush before git snapshot failed: ${e?.message}`),
      );
    }

    const files: Array<{ path: string; content: Buffer }> = [];
    for (const node of nodes) {
      if (node.type === 'FOLDER' || node.path === '/') continue;
      const repoPath = toRepoPath(node.path);
      if (node.docId) {
        try {
          const doc = await this.docstore.getDoc(projectId, node.docId);
          if (doc.deleted) continue;
          files.push({
            path: repoPath,
            content: Buffer.from((doc.lines || []).join('\n'), 'utf8'),
          });
        } catch (err: any) {
          this.logger.warn(`Skipping doc ${node.path}: ${err?.message}`);
        }
      } else if (node.fileId) {
        try {
          const { stream } = await this.filestore.openReadStream(projectId, node.fileId);
          files.push({ path: repoPath, content: await streamToBuffer(stream) });
        } catch (err: any) {
          this.logger.warn(`Skipping file ${node.path}: ${err?.message}`);
        }
      }
    }
    return this.git.commitSnapshot(
      projectId,
      files,
      `Flux snapshot ${new Date().toISOString()}`,
    );
  }

  /** Applies the tree diff old..new into the project. Caller holds lock. */
  async applyPush(
    projectId: string,
    oldSha: string | null,
    newSha: string,
  ): Promise<PushApplyResult> {
    const changes: GitChange[] = parseNameStatusZ(
      await this.git.diffNameStatus(projectId, oldSha, newSha),
    );
    // Validate every path before mutating anything.
    for (const c of changes) toProjectPath(c.path);

    const result: PushApplyResult = { created: [], updated: [], deleted: [] };
    // Deletions first so type changes (doc <-> file) at the same path work.
    const ordered = [
      ...changes.filter((c) => c.status === 'D'),
      ...changes.filter((c) => c.status !== 'D'),
    ];
    for (const change of ordered) {
      const projectPath = toProjectPath(change.path);
      if (change.status === 'D') {
        if (await this.removeEntry(projectId, projectPath)) {
          result.deleted.push(projectPath);
        }
        continue;
      }
      const content = await this.git.readBlob(projectId, newSha, change.path);
      const outcome = await this.upsertEntry(projectId, projectPath, content);
      result[outcome].push(projectPath);
    }
    return result;
  }

  private async removeEntry(projectId: string, projectPath: string): Promise<boolean> {
    const node = await this.structure.getNodeByPath(projectId, projectPath);
    if (!node) return false;
    if (node.docId) {
      // Soft delete: content stays recoverable from Docstore.
      await this.docstore.patchDoc(projectId, node.docId, { deleted: true });
    }
    if (node.fileId) {
      await this.filestore.deleteFile(projectId, node.fileId, false);
    }
    await this.structure.deleteNode(projectId, node.id);
    return true;
  }

  private async upsertEntry(
    projectId: string,
    projectPath: string,
    content: Buffer,
  ): Promise<'created' | 'updated'> {
    const asText = isTextPath(projectPath, content);
    const existing = await this.structure.getNodeByPath(projectId, projectPath);

    if (existing?.docId && asText) {
      const lines = splitLines(content.toString('utf8'));
      const current = await this.docstore.getDoc(projectId, existing.docId);
      await this.docstore.updateDoc(projectId, existing.docId, {
        lines,
        version: (current.version ?? 0) + 1,
      });
      await this.live()
        ?.applyExternalText(projectId, existing.docId, lines.join('\n'))
        .catch(() => false);
      return 'updated';
    }

    let outcome: 'created' | 'updated' = 'created';
    if (existing) {
      // Type change or binary replacement: drop old entry (soft), recreate.
      await this.removeEntry(projectId, projectPath);
      outcome = 'updated';
    }

    const name = projectPath.split('/').pop() as string;
    const dir = projectPath.slice(0, projectPath.length - name.length - 1) || '/';
    const parent = dir === '/' ? null : await this.structure.mkdirp(projectId, dir);

    if (asText) {
      const doc = await this.docstore.createDoc(projectId, {
        path: projectPath,
        lines: splitLines(content.toString('utf8')),
      });
      await this.structure.createNode(projectId, {
        name,
        parentId: parent?.id ?? null,
        type: 'DOC',
        docId: doc.id ?? doc._id,
      });
    } else {
      const file = await this.filestore.uploadFileFromBuffer(projectId, name, content);
      await this.structure.createNode(projectId, {
        name,
        parentId: parent?.id ?? null,
        type: 'FILE',
        fileId: file.id,
      });
    }
    return outcome;
  }
}
