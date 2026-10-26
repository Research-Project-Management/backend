/**
 * modules/manuscripts/clsi/domain/compile-fileset.planner.ts
 * Pure in-process planning of the file set and content-independent fingerprint
 * handed to the LaTeX compilation pipeline.
 */

import * as crypto from 'crypto';
import { TexEngineDetector } from './tex-engine.detector';

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
  fileId?: string | null;
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

export interface ManifestFile {
  id: string;
  name: string;
  sizeBytes: number;
  hash: string | null;
  updatedAt?: Date;
}

export interface FileSetInput {
  nodes: ManifestNode[];
  docs: ManifestDoc[];
  binaryFiles?: ManifestFile[];
  incomingFiles: Record<string, string>;
  source: string;
  mainFile?: string;
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

export function fingerprintFileSet(
  files: Map<string, FileSource>,
  binaryTokens?: Map<string, string>,
): string {
  const lines = Array.from(files.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, s]) => `${p}\u0000${s.token}`);
  if (binaryTokens && binaryTokens.size > 0) {
    const binLines = Array.from(binaryTokens.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([p, tok]) => `bin:${p}\u0000${tok}`);
    lines.push(...binLines);
  }
  return sha256(lines.join('\n'));
}

function detectDocumentClassFromInline(
  files: Map<string, FileSource>,
): string | null {
  const inlineTexFiles: Record<string, string> = {};
  for (const [filename, src] of files.entries()) {
    if (src.kind === 'inline' && filename.endsWith('.tex')) {
      inlineTexFiles[filename] = src.content;
    }
  }
  return TexEngineDetector.detectMainFile(inlineTexFiles);
}

/** Plan for a project persisted in the database (metadata-only, no content read). */
export function planDbFileSet(input: FileSetInput): PlannedFileSet {
  const { nodes, docs, incomingFiles, source, pageId } = input;
  const explicitMainFile = input.mainFile
    ? sanitizeRelativePath(input.mainFile)
    : undefined;

  const docById = new Map(docs.map((d) => [d.id, d]));
  const idToPath = new Map<string, string>();
  const fileIdToPath = new Map<string, string>();
  const files = new Map<string, FileSource>();
  let detectedRootPath: string | null = null;

  for (const node of nodes) {
    if (node.type === 'FOLDER') continue;
    const cleanPath =
      sanitizeRelativePath(node.path || '') || node.name || 'untitled.tex';
    if (node.docId) idToPath.set(node.docId, cleanPath);
    if (node.fileId) fileIdToPath.set(node.fileId, cleanPath);
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

  const inlineRootPath = detectDocumentClassFromInline(files);

  let mainFile = 'main.tex';
  if (
    explicitMainFile &&
    files.has(explicitMainFile) &&
    !isEmpty(files.get(explicitMainFile))
  ) {
    mainFile = explicitMainFile;
  } else if (detectedRootPath) {
    mainFile = detectedRootPath;
  } else if (inlineRootPath) {
    mainFile = inlineRootPath;
  } else if (explicitMainFile) {
    mainFile = explicitMainFile;
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
    if (source) files.set(pagePath, inlineSource(source));
  } else if (source && (source.includes('\\documentclass') || mainWasEmpty)) {
    files.set(mainFile, inlineSource(source));
  }

  const binaryTokens = new Map<string, string>();
  for (const bf of input.binaryFiles || []) {
    const cleanPath =
      fileIdToPath.get(bf.id) || sanitizeRelativePath(bf.name || '');
    if (cleanPath && !files.has(cleanPath)) {
      binaryTokens.set(
        cleanPath,
        `f:${bf.id}:${bf.hash || ''}:${bf.sizeBytes}:${bf.updatedAt?.getTime() ?? 0}`,
      );
    }
  }

  return {
    mainFile,
    files,
    fingerprint: fingerprintFileSet(files, binaryTokens),
    hasMainContent: !isEmpty(files.get(mainFile)),
  };
}

/** Plan for ad-hoc compiles with no persisted project (everything inline). */
export function planInlineFileSet(input: {
  incomingFiles: Record<string, string>;
  source: string;
  mainFile?: string;
}): PlannedFileSet {
  const files = new Map<string, FileSource>();
  for (const [key, content] of Object.entries(input.incomingFiles)) {
    const cleanKey = sanitizeRelativePath(key);
    files.set(cleanKey, inlineSource(content));
  }
  const explicitMain = input.mainFile
    ? sanitizeRelativePath(input.mainFile)
    : undefined;
  const detectedMain = detectDocumentClassFromInline(files);
  const cleanMain = explicitMain || detectedMain || 'main.tex';
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
