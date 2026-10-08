/**
 * clsi/core/pipeline/compile-fileset.ts
 *
 * Pure planning of the file set handed to the LaTeX pipeline.
 *
 * Old behaviour (per compile request): load EVERY doc's full `lines` JSON from Postgres,
 * join them, sort + concatenate all content and SHA-256 the lot — and only then consult
 * the cache. Cost: O(total project bytes) of DB I/O, heap and hashing on every request,
 * including cache hits.
 *
 * New behaviour: plan from lightweight metadata only.
 *  - A DB-backed file is identified by `(docId, rev, updatedAt, sizeBytes)`. `rev` is
 *    incremented by every content write (docstore updateDoc / unarchive) and `updatedAt`
 *    by Prisma on every update, so the tuple changes iff the content changes.
 *  - A client-supplied override (unsaved editor buffer) is identified by SHA-256 of its
 *    content — O(size of overrides), never O(project).
 *  - The fingerprint is SHA-256 over the path-sorted `path ⇥ token` lines:
 *    O(F log F) for F files, independent of bytes.
 * Content is hydrated (one `id IN (…)` query) only on a cache miss.
 */

import * as crypto from 'crypto';

export type FileSource =
  | {
      kind: 'db';
      docId: string;
      token: string;
      sizeBytes: number;
      inStorage: boolean;
    }
  | { kind: 'inline'; content: string; token: string };

export interface ManifestNode {
  id: string;
  docId: string | null;
  path: string | null;
  name: string | null;
  type: string;
  isRootDoc: boolean;
}

export interface ManifestDoc {
  id: string;
  path: string | null;
  rev: number;
  sizeBytes: number;
  updatedAt: Date;
  inStorage?: boolean;
}

export interface FileSetInput {
  nodes: ManifestNode[];
  docs: ManifestDoc[];
  incomingFiles: Record<string, string>;
  source: string;
  mainFile: string;
  pageId?: string;
}

export interface PlannedFileSet {
  mainFile: string;
  files: Map<string, FileSource>;
  fingerprint: string;
  /** True when the entry file is known to have content. */
  hasMainContent: boolean;
}

const sha256 = (s: string) =>
  crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const sanitizeRelativePath = (p: string) =>
  p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '');

const inlineSource = (content: string): FileSource => ({
  kind: 'inline',
  content,
  token: `i:${sha256(content)}`,
});

const dbSource = (doc: ManifestDoc): FileSource => ({
  kind: 'db',
  docId: doc.id,
  sizeBytes: doc.sizeBytes,
  inStorage: !!doc.inStorage,
  token: `d:${doc.id}:${doc.rev}:${doc.updatedAt.getTime()}:${doc.sizeBytes}`,
});

const isEmpty = (s: FileSource | undefined): boolean =>
  !s || (s.kind === 'inline' ? s.content.length === 0 : s.sizeBytes === 0);

export function fingerprintFileSet(files: Map<string, FileSource>): string {
  const lines = Array.from(files.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, s]) => `${p}\u0000${s.token}`);
  return sha256(lines.join('\n'));
}

/** Plan for a project persisted in the database (metadata-only, no content read). */
export function planDbFileSet(input: FileSetInput): PlannedFileSet {
  const { nodes, docs, incomingFiles, source, pageId } = input;
  let mainFile = input.mainFile
    ? sanitizeRelativePath(input.mainFile)
    : 'main.tex';

  const docById = new Map(docs.map((d) => [d.id, d]));
  const idToPath = new Map<string, string>();
  const files = new Map<string, FileSource>();
  let detectedRootPath: string | null = null;

  for (const node of nodes) {
    if (node.type === 'FOLDER') continue;
    const cleanPath =
      sanitizeRelativePath(node.path || '') || node.name || 'untitled.tex';
    if (node.docId) idToPath.set(node.docId, cleanPath);
    idToPath.set(node.id, cleanPath);

    const doc = node.docId ? docById.get(node.docId) : undefined;
    if (doc) files.set(cleanPath, dbSource(doc));
    if (node.isRootDoc) detectedRootPath = cleanPath;
  }

  for (const doc of docs) {
    const cleanPath = sanitizeRelativePath(doc.path || '');
    if (cleanPath && !files.has(cleanPath)) files.set(cleanPath, dbSource(doc));
    idToPath.set(doc.id, cleanPath);
  }

  // Client-side buffers (unsaved edits) take precedence over persisted content.
  for (const [key, content] of Object.entries(incomingFiles)) {
    const rawClean = sanitizeRelativePath(key);
    const targetPath = idToPath.get(key) ?? idToPath.get(rawClean) ?? rawClean;
    files.set(targetPath, inlineSource(content));
  }

  if (mainFile && files.has(mainFile) && !isEmpty(files.get(mainFile))) {
    // Retain client-specified mainFile if present in project
  } else if (detectedRootPath) {
    mainFile = detectedRootPath;
  } else if (!isEmpty(files.get('main.tex'))) {
    mainFile = 'main.tex';
  }

  const mainWasEmpty = isEmpty(files.get(mainFile));
  const cleanPageId = pageId ? sanitizeRelativePath(pageId) : undefined;
  const pagePath = pageId
    ? (idToPath.get(pageId) ??
      idToPath.get(cleanPageId!) ??
      (cleanPageId && files.has(cleanPageId) ? cleanPageId : undefined))
    : undefined;

  if (pagePath && pagePath !== mainFile) {
    // Client is editing a child sub-file: its buffer is that file's content.
    if (source) files.set(pagePath, inlineSource(source));
  } else if (source && (source.includes('\\documentclass') || mainWasEmpty)) {
    files.set(mainFile, inlineSource(source));
  }

  return {
    mainFile,
    files,
    fingerprint: fingerprintFileSet(files),
    hasMainContent: !isEmpty(files.get(mainFile)),
  };
}

/** Plan for ad-hoc compiles with no persisted project (everything inline). */
export function planInlineFileSet(input: {
  incomingFiles: Record<string, string>;
  source: string;
  mainFile: string;
}): PlannedFileSet {
  const files = new Map<string, FileSource>();
  for (const [key, content] of Object.entries(input.incomingFiles)) {
    const cleanKey = sanitizeRelativePath(key);
    files.set(cleanKey, inlineSource(content));
  }
  const cleanMain =
    sanitizeRelativePath(input.mainFile || 'main.tex') || 'main.tex';
  if (input.source && isEmpty(files.get(cleanMain))) {
    files.set(cleanMain, inlineSource(input.source));
  }
  return {
    mainFile: cleanMain,
    files,
    fingerprint: fingerprintFileSet(files),
    hasMainContent: !isEmpty(files.get(cleanMain)),
  };
}

export function linesToText(lines: unknown): string {
  return Array.isArray(lines) ? lines.join('\n') : String(lines ?? '');
}
