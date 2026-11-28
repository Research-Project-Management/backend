/**
 * templates/domain/manifest.domain.ts
 * GoF Prototype Aggregate (`TemplateManifest`):
 * - Projects Virtual Proxy lightweight summaries (`toSummary`) without file blobs.
 * - Computes zero-I/O batch `PageDoc` / `PageFile` / `PageNode` clone plans (`buildPageClonePlan`)
 *   matching `duplicate.service.ts` invariants (`rootDoc.id === page.id`, depth-ordered nodes).
 */

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { InvalidTemplateError } from './errors';
import { TemplateFileView, TemplateFileVo } from './file.domain';
import {
  assertCategory,
  assertCompiler,
  deriveTemplateScope,
  MAX_TEMPLATE_FILES,
  MAX_TEMPLATE_TOTAL_BYTES,
  normalizeTags,
  normalizeTemplatePath,
  TemplateCategory,
  TemplateCompiler,
  TemplateScope,
  toTemplateSlug,
} from './policy';

export interface TemplateSummaryView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly category: TemplateCategory;
  readonly scope: TemplateScope | null;
  readonly isCustom: boolean;
  readonly description: string | null;
  readonly compiler: TemplateCompiler;
  readonly texlive: string;
  readonly mainFile: string;
  readonly author: string | null;
  readonly thumbnail: string | null;
  readonly fileCount: number;
  readonly tags: string[];
  readonly spaceId: string | null;
  readonly sourcePageId: string | null;
  readonly createdById: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TemplateDetailView extends TemplateSummaryView {
  readonly files: TemplateFileView[];
}

export interface PageBatchClonePlan {
  readonly templateId: string;
  readonly pageId: string;
  readonly rootDocId: string;
  readonly title: string;
  readonly compiler: TemplateCompiler;
  readonly texlive: string;
  readonly mainFile: string;
  readonly docsToCreate: Prisma.PageDocCreateManyInput[];
  readonly filesToCreate: Prisma.PageFileCreateManyInput[];
  readonly nodeBatchesByDepth: ReadonlyMap<
    number,
    Prisma.PageNodeCreateManyInput[]
  >;
  readonly blobIncrements: ReadonlyMap<string, number>;
}

export interface TemplateManifestProps {
  readonly id?: string;
  readonly slug?: string | null;
  readonly name: string;
  readonly category?: string | null;
  readonly description?: string | null;
  readonly compiler?: string | null;
  readonly texlive?: string | null;
  readonly mainFile?: string | null;
  readonly author?: string | null;
  readonly thumbnail?: string | null;
  readonly fileCount?: number;
  readonly tags?: readonly string[];
  readonly files?: readonly TemplateFileVo[];
  readonly spaceId?: string | null;
  readonly spaceType?: 'personal' | 'project' | null;
  readonly sourcePageId?: string | null;
  readonly createdById?: string | null;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export class TemplateManifest {
  public readonly id: string;
  public readonly slug: string;
  public readonly name: string;
  public readonly category: TemplateCategory;
  public readonly scope: TemplateScope | null;
  public readonly isCustom: boolean;
  public readonly description: string | null;
  public readonly compiler: TemplateCompiler;
  public readonly texlive: string;
  public readonly mainFile: string;
  public readonly author: string | null;
  public readonly thumbnail: string | null;
  public readonly fileCount: number;
  public readonly tags: readonly string[];
  public readonly files: readonly TemplateFileVo[];
  public readonly spaceId: string | null;
  public readonly sourcePageId: string | null;
  public readonly createdById: string | null;
  public readonly createdAt: Date;
  public readonly updatedAt: Date;

  private constructor(props: {
    id: string;
    slug: string;
    name: string;
    category: TemplateCategory;
    scope: TemplateScope | null;
    isCustom: boolean;
    description: string | null;
    compiler: TemplateCompiler;
    texlive: string;
    mainFile: string;
    author: string | null;
    thumbnail: string | null;
    fileCount: number;
    tags: readonly string[];
    files: readonly TemplateFileVo[];
    spaceId: string | null;
    sourcePageId: string | null;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    this.id = props.id;
    this.slug = props.slug;
    this.name = props.name;
    this.category = props.category;
    this.scope = props.scope;
    this.isCustom = props.isCustom;
    this.description = props.description;
    this.compiler = props.compiler;
    this.texlive = props.texlive;
    this.mainFile = props.mainFile;
    this.author = props.author;
    this.thumbnail = props.thumbnail;
    this.fileCount = props.fileCount;
    this.tags = props.tags;
    this.files = props.files;
    this.spaceId = props.spaceId;
    this.sourcePageId = props.sourcePageId;
    this.createdById = props.createdById;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  public static create(props: TemplateManifestProps): TemplateManifest {
    const cleanName = props.name?.trim();
    if (!cleanName) {
      throw new InvalidTemplateError('Template name cannot be empty');
    }

    const id = props.id || randomUUID();
    const category = assertCategory(props.category);
    const compiler = assertCompiler(props.compiler);
    const texlive = (props.texlive?.trim() || '2025').slice(0, 16);
    const spaceId = props.spaceId ?? null;
    const scope = deriveTemplateScope(
      spaceId,
      props.spaceType,
      props.createdById,
    );
    const tags = normalizeTags(props.tags);
    const files = props.files ? [...props.files] : [];

    if (files.length > MAX_TEMPLATE_FILES) {
      throw new InvalidTemplateError(
        `Template exceeds maximum of ${MAX_TEMPLATE_FILES} files`,
      );
    }

    let totalBytes = 0;
    for (const f of files) {
      totalBytes += f.sizeBytes;
      if (totalBytes > MAX_TEMPLATE_TOTAL_BYTES) {
        throw new InvalidTemplateError(
          'Template exceeds 100 MB maximum total size',
        );
      }
    }

    let mainFile = normalizeTemplatePath(props.mainFile || 'main.tex');
    if (files.length > 0 && !files.some((f) => f.path === mainFile)) {
      const firstTex = files.find((f) => f.path.toLowerCase().endsWith('.tex'));
      if (firstTex) {
        mainFile = firstTex.path;
      } else {
        throw new InvalidTemplateError(
          `Main file "${mainFile}" does not exist in template files`,
        );
      }
    }

    const slug = props.slug?.trim() || toTemplateSlug(cleanName, id.slice(0, 8));

    return new TemplateManifest({
      id,
      slug,
      name: cleanName.slice(0, 255),
      category,
      scope,
      isCustom: Boolean(spaceId),
      description: props.description?.trim() ?? null,
      compiler,
      texlive,
      mainFile,
      author: props.author?.trim() ? props.author.trim().slice(0, 255) : null,
      thumbnail: props.thumbnail?.trim() ?? null,
      fileCount: props.fileCount ?? files.length,
      tags,
      files,
      spaceId,
      sourcePageId: props.sourcePageId ?? null,
      createdById: props.createdById ?? null,
      createdAt: props.createdAt ?? new Date(),
      updatedAt: props.updatedAt ?? new Date(),
    });
  }

  public toSummary(): TemplateSummaryView {
    return {
      id: this.id,
      slug: this.slug,
      name: this.name,
      category: this.category,
      scope: this.scope,
      isCustom: this.isCustom,
      description: this.description,
      compiler: this.compiler,
      texlive: this.texlive,
      mainFile: this.mainFile,
      author: this.author,
      thumbnail: this.thumbnail,
      fileCount: this.fileCount,
      tags: [...this.tags],
      spaceId: this.spaceId,
      sourcePageId: this.sourcePageId,
      createdById: this.createdById,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }

  public toDetail(): TemplateDetailView {
    return {
      ...this.toSummary(),
      files: this.files.map((f) => f.toView()),
    };
  }

  /**
   * GoF Prototype `clone()` aligned 1:1 with `duplicate.service.ts`:
   * Pure zero-I/O planner generating batchable `PageDoc`, `PageFile` (zero-copy `FileBlob`),
   * and depth-ordered `PageNode` rows with `rootDoc.id === pageId`.
   */
  public buildPageClonePlan(params: {
    spaceId: string;
    pageId?: string;
    customTitle?: string;
  }): PageBatchClonePlan {
    const pageId = params.pageId || randomUUID();
    const title = (params.customTitle?.trim() || this.name).slice(0, 255);
    const docsToCreate: Prisma.PageDocCreateManyInput[] = [];
    const filesToCreate: Prisma.PageFileCreateManyInput[] = [];
    const nodeBatchesByDepth = new Map<
      number,
      Prisma.PageNodeCreateManyInput[]
    >();
    const blobIncrements = new Map<string, number>();

    const folderIdByPath = new Map<string, string>();
    let rootDocId = pageId;

    const pushNode = (depth: number, row: Prisma.PageNodeCreateManyInput) => {
      const batch = nodeBatchesByDepth.get(depth) ?? [];
      batch.push(row);
      nodeBatchesByDepth.set(depth, batch);
    };

    const ensureFolderChain = (segments: readonly string[]): string | null => {
      let currentPath = '';
      let parentId: string | null = null;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        currentPath += `/${seg}`;
        let folderId = folderIdByPath.get(currentPath);
        if (!folderId) {
          folderId = randomUUID();
          folderIdByPath.set(currentPath, folderId);
          pushNode(i + 1, {
            id: folderId,
            spaceId: params.spaceId,
            pageId,
            parentId,
            type: 'FOLDER',
            name: seg,
            path: currentPath,
            depth: i + 1,
            docId: null,
            fileId: null,
            sortOrder: 0,
          });
        }
        parentId = folderId;
      }
      return parentId;
    };

    for (let idx = 0; idx < this.files.length; idx++) {
      const entry = this.files[idx];
      const parts = entry.path.split('/');
      const name = parts[parts.length - 1];
      const dirSegments = parts.slice(0, -1);
      const parentId =
        dirSegments.length > 0 ? ensureFolderChain(dirSegments) : null;
      const nodePath = `/${entry.path}`;
      const depth = parts.length;
      const isMain = entry.path === this.mainFile;

      if (entry.type === 'DOC') {
        const docId = isMain ? pageId : randomUUID();
        if (isMain) rootDocId = docId;
        const lines = (entry.textContent ?? '').split('\n');

        docsToCreate.push({
          id: docId,
          spaceId: params.spaceId,
          pageId,
          lastKnownPath: nodePath,
          lines,
          rev: 1,
          version: 1,
          ranges: (isMain ? { title } : {}) as Prisma.InputJsonValue,
          hash: entry.contentHash,
          sizeBytes: entry.sizeBytes,
          inStorage: false,
          storageKey: null,
        });

        pushNode(depth, {
          id: randomUUID(),
          spaceId: params.spaceId,
          pageId,
          parentId,
          type: 'DOC',
          name,
          path: nodePath,
          depth,
          docId,
          fileId: null,
          sortOrder: idx,
        });
      } else if (entry.storageKey) {
        const fileId = randomUUID();
        filesToCreate.push({
          id: fileId,
          spaceId: params.spaceId,
          pageId,
          blobId: entry.blobId,
          lastKnownPath: nodePath,
          mimeType: entry.mimeType,
          sizeBytes: entry.sizeBytes,
          hash: entry.contentHash,
          storageKey: entry.storageKey,
          bucketName: entry.bucketName || 'manuscript-files',
          rev: 0,
        });

        if (entry.blobId) {
          blobIncrements.set(
            entry.blobId,
            (blobIncrements.get(entry.blobId) ?? 0) + 1,
          );
        }

        pushNode(depth, {
          id: randomUUID(),
          spaceId: params.spaceId,
          pageId,
          parentId,
          type: 'FILE',
          name,
          path: nodePath,
          depth,
          docId: null,
          fileId,
          sortOrder: idx,
        });
      }
    }

    return {
      templateId: this.id,
      pageId,
      rootDocId,
      title,
      compiler: this.compiler,
      texlive: this.texlive,
      mainFile: this.mainFile,
      docsToCreate,
      filesToCreate,
      nodeBatchesByDepth,
      blobIncrements,
    };
  }
}
