/**
 * git-bridge/adapters/repo.adapter.ts
 * GoF Adapter + Composite (`DirNode`) + Caching Proxy (`merkleCache`) over `isomorphic-git`:
 * Builds Git blobs, trees, and commits directly in `.git/objects` (0 `.work` directory,
 * 100% `.gitignore` immune) and computes subtree-pruned diffs in-process.
 */

import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as isoGit from 'isomorphic-git';
import { LRUCache } from 'lru-cache';
import { readPagesConfig } from '@/modules/pages/core';
import { DEFAULT_BRANCH, MAIN_REF, RepoPathVo } from '../domain/policy';
import {
  EMPTY_TREE_OID,
  runBlobGuards,
  runTreeGuards,
} from '../domain/pack.domain';

export interface BlobEntry {
  readonly path: RepoPathVo;
  readonly content: Buffer;
  readonly sha256?: string;
}

export interface GitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface DiffEntry {
  readonly status: 'A' | 'M' | 'D';
  readonly path: RepoPathVo;
  readonly oid?: string;
  readonly content?: Buffer;
}

export interface PushDiff {
  readonly message: string;
  readonly treeOid: string;
  readonly entries: DiffEntry[];
  readonly totalBytes: number;
}

interface MerkleState {
  headOid: string;
  treeOid: string;
  blobsByHash: Map<string, string>;
}

/**
 * GoF Composite Pattern: Recursive directory node holding leaf blob OIDs and child subtrees.
 * Persists bottom-up into `.git/objects` via `writeTree`.
 */
class DirNode {
  private readonly blobs = new Map<string, string>();
  private readonly dirs = new Map<string, DirNode>();

  public insert(segments: readonly string[], blobOid: string): void {
    DirNode.insertInto(this, segments, blobOid);
  }

  private static insertInto(
    root: DirNode,
    segments: readonly string[],
    blobOid: string,
  ): void {
    let cur = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const name = segments[i];
      let next = cur.dirs.get(name);
      if (!next) {
        next = new DirNode();
        cur.dirs.set(name, next);
      }
      cur = next;
    }
    cur.blobs.set(segments[segments.length - 1], blobOid);
  }

  public async writeToGit(gitdir: string): Promise<string> {
    if (this.blobs.size === 0 && this.dirs.size === 0) {
      return isoGit.writeTree({ fs, gitdir, tree: [] });
    }

    const items: isoGit.TreeEntry[] = [];
    for (const [name, sub] of this.dirs.entries()) {
      const subOid = await sub.writeToGit(gitdir);
      if (subOid !== EMPTY_TREE_OID) {
        items.push({ mode: '040000', path: name, oid: subOid, type: 'tree' });
      }
    }
    for (const [name, oid] of this.blobs.entries()) {
      items.push({ mode: '100644', path: name, oid, type: 'blob' });
    }
    return isoGit.writeTree({ fs, gitdir, tree: items });
  }
}

@Injectable()
export class RepoAdapter {
  public readonly rootDir: string;
  private readonly defaultAuthor: GitAuthor;
  private readonly touchedAt = new Map<string, number>();

  private readonly merkleCache = new LRUCache<string, MerkleState>({
    max: 256,
    ttl: 60 * 60 * 1000,
  });

  private readonly packIdxCache = new LRUCache<string, Record<string, unknown>>(
    {
      max: 128,
      ttl: 30 * 60 * 1000,
    },
  );

  constructor() {
    const { gitBridge } = readPagesConfig();
    this.rootDir = gitBridge.root;
    this.defaultAuthor = {
      name: gitBridge.authorName,
      email: gitBridge.authorEmail,
    };
  }

  public bareDir(repoId: string): string {
    return path.join(this.rootDir, `${repoId}.git`);
  }

  public touch(repoId: string): void {
    this.touchedAt.set(repoId, Date.now());
  }

  public getTouchedMap(): ReadonlyMap<string, number> {
    return this.touchedAt;
  }

  private getIdxCache(repoId: string): Record<string, unknown> {
    let cache = this.packIdxCache.get(repoId);
    if (!cache) {
      cache = {};
      this.packIdxCache.set(repoId, cache);
    }
    return cache;
  }

  public clearPackCache(repoId: string): void {
    this.packIdxCache.delete(repoId);
  }

  public async ensureBare(repoId: string): Promise<string> {
    this.touch(repoId);
    const gitdir = this.bareDir(repoId);
    try {
      await fsp.access(path.join(gitdir, 'HEAD'));
      return gitdir;
    } catch {
      // Initialize below
    }

    await fsp.mkdir(gitdir, { recursive: true });
    await isoGit.init({
      fs,
      dir: gitdir,
      gitdir,
      bare: true,
      defaultBranch: DEFAULT_BRANCH,
    });

    const cfg = [
      '[core]',
      '\trepositoryformatversion = 0',
      '\tfilemode = false',
      '\tbare = true',
      '\tautocrlf = false',
      '[receive]',
      '\tdenyNonFastForwards = true',
      '\tdenyDeletes = true',
      '[uploadpack]',
      '\tallowFilter = true',
      '',
    ].join('\n');
    await fsp.writeFile(path.join(gitdir, 'config'), cfg, 'utf8');
    return gitdir;
  }

  public async resolveRef(
    repoId: string,
    ref: string = MAIN_REF,
  ): Promise<string | null> {
    try {
      return await isoGit.resolveRef({ fs, gitdir: this.bareDir(repoId), ref });
    } catch {
      return null;
    }
  }

  public async listRefs(repoId: string): Promise<string[]> {
    const gitdir = this.bareDir(repoId);
    const refs = new Set<string>();

    const [branches, tags] = await Promise.all([
      isoGit.listBranches({ fs, gitdir }).catch(() => [] as string[]),
      isoGit.listTags({ fs, gitdir }).catch(() => [] as string[]),
    ]);
    for (const b of branches) refs.add(`refs/heads/${b}`);
    for (const t of tags) refs.add(`refs/tags/${t}`);

    const walk = async (dir: string, prefix: string): Promise<void> => {
      const list = await fsp
        .readdir(dir, { withFileTypes: true })
        .catch(() => []);
      for (const item of list) {
        const rel = `${prefix}/${item.name}`;
        if (item.isDirectory()) await walk(path.join(dir, item.name), rel);
        else if (item.isFile()) refs.add(rel);
      }
    };
    await walk(path.join(gitdir, 'refs'), 'refs');

    return Array.from(refs);
  }

  public async deleteRef(repoId: string, ref: string): Promise<void> {
    await isoGit
      .deleteRef({ fs, gitdir: this.bareDir(repoId), ref })
      .catch(() => undefined);
  }

  public async setMainRef(repoId: string, oid: string | null): Promise<void> {
    const gitdir = this.bareDir(repoId);
    if (!oid) {
      await isoGit
        .deleteRef({ fs, gitdir, ref: MAIN_REF })
        .catch(() => undefined);
      this.merkleCache.delete(repoId);
      return;
    }
    await isoGit.writeRef({
      fs,
      gitdir,
      ref: MAIN_REF,
      value: oid,
      force: true,
    });
  }

  public async isAncestor(
    repoId: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    if (ancestor === descendant) return true;
    try {
      return await isoGit.isDescendent({
        fs,
        gitdir: this.bareDir(repoId),
        oid: descendant,
        ancestor,
        cache: this.getIdxCache(repoId),
      });
    } catch {
      return false;
    }
  }

  public async commitTree(
    repoId: string,
    files: BlobEntry[],
    message: string,
    author?: Partial<GitAuthor>,
  ): Promise<{ headOid: string; treeOid: string }> {
    const gitdir = await this.ensureBare(repoId);
    const cache = this.getIdxCache(repoId);
    const parentOid = await this.resolveRef(repoId);

    let parentTree: string | null = null;
    if (parentOid) {
      const parent = await isoGit
        .readCommit({ fs, gitdir, oid: parentOid, cache })
        .catch(() => null);
      parentTree = parent?.commit.tree ?? null;
    }

    const prev = this.merkleCache.get(repoId);
    const nextBlobs = new Map<string, string>();
    const root = new DirNode();

    for (const file of files) {
      const hash =
        file.sha256 ?? createHash('sha256').update(file.content).digest('hex');

      let oid = prev?.blobsByHash.get(hash);
      if (oid) {
        const exists = await isoGit
          .readObject({ fs, gitdir, oid, format: 'deflated', cache })
          .then(() => true)
          .catch(() => false);
        if (!exists) oid = undefined;
      }
      if (!oid) {
        oid = await isoGit.writeBlob({ fs, gitdir, blob: file.content });
      }
      nextBlobs.set(hash, oid);
      root.insert(file.path.segments, oid);
    }

    const treeOid = await root.writeToGit(gitdir);

    if (parentOid && parentTree === treeOid) {
      this.merkleCache.set(repoId, {
        headOid: parentOid,
        treeOid,
        blobsByHash: nextBlobs,
      });
      return { headOid: parentOid, treeOid };
    }

    const who = {
      name: author?.name?.trim() || this.defaultAuthor.name,
      email: author?.email?.trim() || this.defaultAuthor.email,
      timestamp: Math.floor(Date.now() / 1000),
      timezoneOffset: 0,
    };

    const headOid = await isoGit.writeCommit({
      fs,
      gitdir,
      commit: {
        message: message.endsWith('\n') ? message : `${message}\n`,
        tree: treeOid,
        parent: parentOid ? [parentOid] : [],
        author: who,
        committer: who,
      },
    });

    await this.setMainRef(repoId, headOid);
    this.merkleCache.set(repoId, {
      headOid,
      treeOid,
      blobsByHash: nextBlobs,
    });
    return { headOid, treeOid };
  }

  public recordPush(repoId: string, headOid: string, treeOid: string): void {
    const prev = this.merkleCache.get(repoId);
    this.merkleCache.set(repoId, {
      headOid,
      treeOid,
      blobsByHash: prev?.blobsByHash ?? new Map(),
    });
  }

  public async diffCommits(
    repoId: string,
    oldSha: string | null,
    newSha: string,
  ): Promise<PushDiff> {
    const gitdir = this.bareDir(repoId);
    const cache = this.getIdxCache(repoId);

    const nextCommit = await isoGit.readCommit({
      fs,
      gitdir,
      oid: newSha,
      cache,
    });
    const newTree = nextCommit.commit.tree;

    let oldTree: string | null = null;
    if (oldSha) {
      const prevCommit = await isoGit.readCommit({
        fs,
        gitdir,
        oid: oldSha,
        cache,
      });
      oldTree = prevCommit.commit.tree;
    }

    // Phase 1: Run Chain of Responsibility tree guards on target tree
    let fileCount = 0;
    const auditTree = async (oid: string, prefix: string): Promise<void> => {
      if (oid === EMPTY_TREE_OID) return;
      const { tree } = await isoGit.readTree({ fs, gitdir, oid, cache });
      for (const item of tree) {
        const rawPath = prefix ? `${prefix}/${item.path}` : item.path;
        if (item.type !== 'tree') fileCount += 1;
        runTreeGuards({ mode: item.mode, rawPath, fileCount });
        if (item.type === 'tree') {
          await auditTree(item.oid, rawPath);
        }
      }
    };
    await auditTree(newTree, '');

    // Phase 2: Subtree-pruned Merkle diff
    const changes: DiffEntry[] = [];

    const collectAll = async (
      oid: string,
      prefix: string,
      status: 'A' | 'D',
    ): Promise<void> => {
      if (oid === EMPTY_TREE_OID) return;
      const { tree } = await isoGit.readTree({ fs, gitdir, oid, cache });
      for (const item of tree) {
        const raw = prefix ? `${prefix}/${item.path}` : item.path;
        if (item.type === 'tree') {
          await collectAll(item.oid, raw, status);
        } else {
          changes.push({
            status,
            path: RepoPathVo.fromRepo(raw),
            ...(status === 'A' ? { oid: item.oid } : {}),
          });
        }
      }
    };

    const compareTrees = async (
      aOid: string | null,
      bOid: string | null,
      prefix: string,
    ): Promise<void> => {
      if (aOid === bOid) return;
      if (!aOid || aOid === EMPTY_TREE_OID) {
        if (bOid) await collectAll(bOid, prefix, 'A');
        return;
      }
      if (!bOid || bOid === EMPTY_TREE_OID) {
        await collectAll(aOid, prefix, 'D');
        return;
      }

      const [aRes, bRes] = await Promise.all([
        isoGit.readTree({ fs, gitdir, oid: aOid, cache }),
        isoGit.readTree({ fs, gitdir, oid: bOid, cache }),
      ]);
      const aMap = new Map(aRes.tree.map((e) => [e.path, e]));
      const bMap = new Map(bRes.tree.map((e) => [e.path, e]));

      for (const [name, oldItem] of aMap.entries()) {
        const raw = prefix ? `${prefix}/${name}` : name;
        const newItem = bMap.get(name);
        if (!newItem) {
          if (oldItem.type === 'tree') await collectAll(oldItem.oid, raw, 'D');
          else changes.push({ status: 'D', path: RepoPathVo.fromRepo(raw) });
        } else if (oldItem.type !== newItem.type) {
          if (oldItem.type === 'tree') await collectAll(oldItem.oid, raw, 'D');
          else changes.push({ status: 'D', path: RepoPathVo.fromRepo(raw) });

          if (newItem.type === 'tree') await collectAll(newItem.oid, raw, 'A');
          else {
            changes.push({
              status: 'A',
              path: RepoPathVo.fromRepo(raw),
              oid: newItem.oid,
            });
          }
        } else if (oldItem.oid !== newItem.oid) {
          if (newItem.type === 'tree') {
            await compareTrees(oldItem.oid, newItem.oid, raw);
          } else {
            changes.push({
              status: 'M',
              path: RepoPathVo.fromRepo(raw),
              oid: newItem.oid,
            });
          }
        }
      }

      for (const [name, newItem] of bMap.entries()) {
        if (aMap.has(name)) continue;
        const raw = prefix ? `${prefix}/${name}` : name;
        if (newItem.type === 'tree') await collectAll(newItem.oid, raw, 'A');
        else {
          changes.push({
            status: 'A',
            path: RepoPathVo.fromRepo(raw),
            oid: newItem.oid,
          });
        }
      }
    };

    await compareTrees(oldTree, newTree, '');

    const ordered = [
      ...changes.filter((c) => c.status === 'D'),
      ...changes.filter((c) => c.status !== 'D'),
    ];

    // Phase 3: Read blobs & run Chain of Responsibility blob guards
    const entries: DiffEntry[] = [];
    let totalBytes = 0;

    for (const item of ordered) {
      if (item.status === 'D') {
        entries.push(item);
        continue;
      }
      const { blob } = await isoGit.readBlob({
        fs,
        gitdir,
        oid: item.oid!,
        cache,
      });
      const content = Buffer.from(
        blob.buffer,
        blob.byteOffset,
        blob.byteLength,
      );
      totalBytes += content.length;
      runBlobGuards({ path: item.path, content, cumulativeBytes: totalBytes });
      entries.push({ ...item, content });
    }

    return {
      message: nextCommit.commit.message.trim(),
      treeOid: newTree,
      entries,
      totalBytes,
    };
  }

  public async evict(repoId: string): Promise<void> {
    this.merkleCache.delete(repoId);
    this.packIdxCache.delete(repoId);
    this.touchedAt.delete(repoId);

    await fsp
      .rm(this.bareDir(repoId), { recursive: true, force: true })
      .catch(() => undefined);
  }
}
