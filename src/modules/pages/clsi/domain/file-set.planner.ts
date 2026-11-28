/**
 * modules/pages/clsi/domain/file-set.planner.ts
 * Pure in-process planning of the file set and content-independent fingerprint
 * handed to the LaTeX compilation pipeline.
 */

import * as crypto from 'crypto';
import { TexEngineDetector } from './compile.policy';
import { SafePath } from './path.policy';
import type { CompileValidationIssue } from './ports';

type FileSource =
  | {
      kind: 'db';
      docId: string;
      token: string;
      sizeBytes: number;
      inStorage: boolean;
    }
  | { kind: 'inline'; content: string; token: string };

interface ManifestNode {
  id: string;
  docId: string | null;
  fileId?: string | null;
  path: string | null;
  name: string | null;
  type: string;
  isRootDoc: boolean;
}

interface ManifestDoc {
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

interface FileSetInput {
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
  /** Duplicate normalized virtual tree paths detected during planning. */
  conflictedPaths?: string[];
  /** Cached metadata from DB planning to avoid redundant DB queries during hydration/snapshots. */
  nodes?: ManifestNode[];
  docs?: ManifestDoc[];
  binaryFiles?: ManifestFile[];
}

export const DEFAULT_MAX_PROJECT_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;

const sha256 = (s: string) =>
  crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const sanitizeRelativePath = SafePath.normalizeRelPath;

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

function fingerprintFileSet(
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

const PREAMBLE_FILENAME_REGEX =
  /(?:^|\/)(?:preamble|macros?|settings|setup|config)\.tex$/i;

function pickFallbackNonEmptyTexFile(
  files: Map<string, FileSource>,
): string | null {
  const candidates: string[] = [];
  for (const [filePath, src] of files.entries()) {
    if (filePath.toLowerCase().endsWith('.tex') && !isEmpty(src)) {
      candidates.push(filePath);
    }
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  candidates.sort((a, b) => {
    const aPreamble = PREAMBLE_FILENAME_REGEX.test(a) ? 1 : 0;
    const bPreamble = PREAMBLE_FILENAME_REGEX.test(b) ? 1 : 0;
    if (aPreamble !== bPreamble) return aPreamble - bPreamble;

    const aDepth = a.split('/').length;
    const bDepth = b.split('/').length;
    if (aDepth !== bDepth) return aDepth - bDepth;

    return a < b ? -1 : a > b ? 1 : 0;
  });
  return candidates[0];
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
  const seenNodePaths = new Set<string>();
  const conflictedPaths = new Set<string>();
  let detectedRootPath: string | null = null;

  for (const node of nodes) {
    if (node.type === 'FOLDER') continue;
    const cleanPath =
      sanitizeRelativePath(node.path || '') || node.name || 'untitled.tex';
    if (seenNodePaths.has(cleanPath)) {
      conflictedPaths.add(cleanPath);
    } else {
      seenNodePaths.add(cleanPath);
    }
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
    if (cleanPath && !idToPath.has(doc.id)) {
      idToPath.set(doc.id, cleanPath);
    }
  }

  // Client-side buffers (unsaved edits) take precedence over persisted content.
  for (const [key, content] of Object.entries(incomingFiles)) {
    const rawClean = sanitizeRelativePath(key);
    const targetPath = idToPath.get(key) ?? idToPath.get(rawClean) ?? rawClean;
    files.set(targetPath, inlineSource(content));
  }

  const inlineRootPath = detectDocumentClassFromInline(files);
  const hasValidExplicit =
    Boolean(explicitMainFile) &&
    files.has(explicitMainFile!) &&
    !isEmpty(files.get(explicitMainFile!));
  const hasValidMainTex = !isEmpty(files.get('main.tex'));
  const fallbackNonEmptyTex = pickFallbackNonEmptyTexFile(files);

  let mainFile = 'main.tex';
  if (hasValidExplicit) {
    mainFile = explicitMainFile!;
  } else if (detectedRootPath) {
    // Authoritative Page.rootDocId always wins over a stale/missing client explicitMainFile.
    // Also preserves validation-problems when the designated root doc itself is empty (0 bytes).
    mainFile = detectedRootPath;
  } else if (inlineRootPath) {
    mainFile = inlineRootPath;
  } else if (hasValidMainTex) {
    mainFile = 'main.tex';
  } else if (fallbackNonEmptyTex) {
    mainFile = fallbackNonEmptyTex;
  } else if (explicitMainFile) {
    mainFile = explicitMainFile;
  }

  const mainWasEmpty = isEmpty(files.get(mainFile));
  const cleanPageId = pageId ? sanitizeRelativePath(pageId) : undefined;
  const pagePath = pageId
    ? (idToPath.get(pageId) ??
      idToPath.get(cleanPageId!) ??
      (cleanPageId && files.has(cleanPageId) ? cleanPageId : undefined))
    : undefined;

  const sourceHasDocClass = Boolean(source && /\\documentclass\b/.test(source));
  if (pagePath && pagePath !== mainFile) {
    if (source && !sourceHasDocClass && !(pagePath in incomingFiles)) {
      files.set(pagePath, inlineSource(source));
    }
  } else if (source && (sourceHasDocClass || mainWasEmpty)) {
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
    ...(conflictedPaths.size > 0
      ? { conflictedPaths: Array.from(conflictedPaths) }
      : {}),
    nodes,
    docs,
    binaryFiles: input.binaryFiles,
  };
}

/**
 * Pure pre-compile structural validator executed before queuing or calling `flux_clsi`.
 * Detects missing/empty Main file, conflicting duplicate tree paths, and size quota breaches.
 */
export function validatePlannedFileSet(
  plan: PlannedFileSet,
  options: { maxProjectBytes?: number; maxFileBytes?: number } = {},
): CompileValidationIssue[] {
  const issues: CompileValidationIssue[] = [];
  const maxProjectBytes = options.maxProjectBytes ?? DEFAULT_MAX_PROJECT_BYTES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  if (!plan.hasMainContent) {
    const availableTexFiles = Array.from(plan.files.keys()).filter((p) =>
      p.toLowerCase().endsWith('.tex'),
    );
    issues.push({
      code: 'mainFile',
      mainFile: plan.mainFile,
      availableTexFiles,
      message: `Main TeX document "${plan.mainFile}" is missing or empty.`,
    });
  }

  if (plan.conflictedPaths && plan.conflictedPaths.length > 0) {
    issues.push({
      code: 'conflictedPaths',
      paths: [...plan.conflictedPaths],
      message: `Conflicting duplicate file path(s): ${plan.conflictedPaths.join(', ')}`,
    });
  }

  let totalBytes = 0;
  const offendingFiles: Array<{ path: string; sizeBytes: number }> = [];

  for (const [filePath, src] of plan.files.entries()) {
    const sizeBytes =
      src.kind === 'db'
        ? Math.max(0, src.sizeBytes || 0)
        : Buffer.byteLength(src.content || '', 'utf8');
    totalBytes += sizeBytes;
    if (sizeBytes > maxFileBytes) {
      offendingFiles.push({ path: filePath, sizeBytes });
    }
  }

  for (const bf of plan.binaryFiles || []) {
    const sizeBytes = Math.max(0, bf.sizeBytes || 0);
    totalBytes += sizeBytes;
    if (sizeBytes > maxFileBytes) {
      offendingFiles.push({
        path: sanitizeRelativePath(bf.name || bf.id),
        sizeBytes,
      });
    }
  }

  if (totalBytes > maxProjectBytes || offendingFiles.length > 0) {
    offendingFiles.sort((a, b) => b.sizeBytes - a.sizeBytes);
    issues.push({
      code: 'sizeCheck',
      totalBytes,
      limitBytes: maxProjectBytes,
      fileLimitBytes: maxFileBytes,
      offendingFiles,
      message:
        totalBytes > maxProjectBytes
          ? `Project size (${(totalBytes / (1024 * 1024)).toFixed(1)} MB) exceeds ${(maxProjectBytes / (1024 * 1024)).toFixed(0)} MB limit.`
          : `One or more files exceed the ${(maxFileBytes / (1024 * 1024)).toFixed(0)} MB per-file limit.`,
    });
  }

  return issues;
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
  const hasValidExplicit =
    Boolean(explicitMain) &&
    files.has(explicitMain!) &&
    !isEmpty(files.get(explicitMain!));
  const hasValidMainTex = !isEmpty(files.get('main.tex'));
  const fallbackNonEmptyTex = pickFallbackNonEmptyTexFile(files);

  let cleanMain = 'main.tex';
  if (hasValidExplicit) {
    cleanMain = explicitMain!;
  } else if (input.source && explicitMain && files.size === 0) {
    cleanMain = explicitMain;
  } else if (detectedMain) {
    cleanMain = detectedMain;
  } else if (hasValidMainTex) {
    cleanMain = 'main.tex';
  } else if (fallbackNonEmptyTex) {
    cleanMain = fallbackNonEmptyTex;
  } else if (explicitMain) {
    cleanMain = explicitMain;
  }
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
