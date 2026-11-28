/**
 * templates/domain/manifest.domain.ts
 * GoF Prototype Aggregate (`TemplateManifest`):
 * - Projects Virtual Proxy lightweight summaries (`toSummary`) without file blobs.
 * - Clones isolated workspace hydration plans (`clonePlan`) via Prototype pattern.
 */

import { randomUUID } from 'node:crypto';
import { InvalidTemplateError } from './errors';
import { TemplateFileView, TemplateFileVo } from './file.domain';
import {
  assertCategory,
  assertCompiler,
  assertVisibility,
  MAX_TEMPLATE_FILES,
  MAX_TEMPLATE_TOTAL_BYTES,
  normalizeTags,
  normalizeTemplatePath,
  TemplateCategory,
  TemplateCompiler,
  TemplateVisibility,
} from './policy';

export interface TemplateSummaryView {
  readonly id: string;
  readonly slug: string | null;
  readonly versionId: string;
  readonly name: string;
  readonly category: TemplateCategory;
  readonly visibility: TemplateVisibility;
  readonly description: string | null;
  readonly compiler: TemplateCompiler;
  readonly texLiveVersion: string;
  readonly mainFile: string;
  readonly badge: string;
  readonly author: string;
  readonly license: string | null;
  readonly sourceUrl: string | null;
  readonly thumbnailUrl: string | null;
  readonly downloadCount: number;
  readonly fileCount: number;
  readonly tags: string[];
  readonly spaceId: string | null;
  readonly createdById: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TemplateDetailView extends TemplateSummaryView {
  readonly files: TemplateFileView[];
}

export interface WorkspaceClonePlan {
  readonly templateId: string;
  readonly versionId: string;
  readonly title: string;
  readonly compiler: TemplateCompiler;
  readonly texLiveVersion: string;
  readonly mainFile: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly projectPath: string;
    readonly name: string;
    readonly dir: string;
    readonly kind: 'doc' | 'file';
    readonly mimeType: string;
    readonly text?: string;
    readonly buffer: Buffer;
  }>;
}

function extractLatexBadge(
  files: readonly TemplateFileVo[],
  mainFile: string,
  tags: readonly string[],
  compiler: string,
): string {
  const main =
    files.find((f) => f.path === mainFile && f.kind === 'doc') ??
    files.find(
      (f) => f.kind === 'doc' && f.path.toLowerCase().endsWith('.tex'),
    );
  const match = main?.textContent?.match(
    /\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/,
  );
  return (match?.[1]?.trim() || tags[0] || compiler).slice(0, 64);
}

export interface TemplateManifestProps {
  readonly id?: string;
  readonly slug?: string | null;
  readonly versionId?: string;
  readonly name: string;
  readonly category?: string | null;
  readonly visibility?: string | null;
  readonly description?: string | null;
  readonly compiler?: string | null;
  readonly texLiveVersion?: string | null;
  readonly mainFile?: string | null;
  readonly badge?: string | null;
  readonly author?: string | null;
  readonly license?: string | null;
  readonly sourceUrl?: string | null;
  readonly thumbnailUrl?: string | null;
  readonly downloadCount?: number;
  readonly fileCount?: number;
  readonly tags?: readonly string[];
  readonly files?: readonly TemplateFileVo[];
  readonly spaceId?: string | null;
  readonly createdById?: string | null;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export class TemplateManifest {
  public readonly id: string;
  public readonly slug: string | null;
  public readonly versionId: string;
  public readonly name: string;
  public readonly category: TemplateCategory;
  public readonly visibility: TemplateVisibility;
  public readonly description: string | null;
  public readonly compiler: TemplateCompiler;
  public readonly texLiveVersion: string;
  public readonly mainFile: string;
  public readonly badge: string;
  public readonly author: string;
  public readonly license: string | null;
  public readonly sourceUrl: string | null;
  public readonly thumbnailUrl: string | null;
  public readonly downloadCount: number;
  public readonly fileCount: number;
  public readonly tags: readonly string[];
  public readonly files: readonly TemplateFileVo[];
  public readonly spaceId: string | null;
  public readonly createdById: string | null;
  public readonly createdAt: Date;
  public readonly updatedAt: Date;

  private constructor(props: {
    id: string;
    slug: string | null;
    versionId: string;
    name: string;
    category: TemplateCategory;
    visibility: TemplateVisibility;
    description: string | null;
    compiler: TemplateCompiler;
    texLiveVersion: string;
    mainFile: string;
    badge: string;
    author: string;
    license: string | null;
    sourceUrl: string | null;
    thumbnailUrl: string | null;
    downloadCount: number;
    fileCount: number;
    tags: readonly string[];
    files: readonly TemplateFileVo[];
    spaceId: string | null;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    this.id = props.id;
    this.slug = props.slug;
    this.versionId = props.versionId;
    this.name = props.name;
    this.category = props.category;
    this.visibility = props.visibility;
    this.description = props.description;
    this.compiler = props.compiler;
    this.texLiveVersion = props.texLiveVersion;
    this.mainFile = props.mainFile;
    this.badge = props.badge;
    this.author = props.author;
    this.license = props.license;
    this.sourceUrl = props.sourceUrl;
    this.thumbnailUrl = props.thumbnailUrl;
    this.downloadCount = props.downloadCount;
    this.fileCount = props.fileCount;
    this.tags = props.tags;
    this.files = props.files;
    this.spaceId = props.spaceId;
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
    const versionId =
      props.versionId || `v-${id.slice(0, 8)}-${Date.now().toString(36)}`;
    const category = assertCategory(props.category);
    const visibility = assertVisibility(props.visibility);
    const compiler = assertCompiler(props.compiler);
    const texLiveVersion = (props.texLiveVersion?.trim() || '2024').slice(
      0,
      16,
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
          'Template exceeds 50 MB maximum total size',
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

    const badge =
      props.badge?.trim() || extractLatexBadge(files, mainFile, tags, compiler);

    return new TemplateManifest({
      id,
      slug: props.slug?.trim() || null,
      versionId,
      name: cleanName.slice(0, 255),
      category,
      visibility,
      description: props.description?.trim() ?? null,
      compiler,
      texLiveVersion,
      mainFile,
      badge,
      author: (props.author?.trim() || 'Flux Community').slice(0, 255),
      license: props.license === undefined ? 'LPPL-1.3c' : props.license,
      sourceUrl: props.sourceUrl?.trim() ?? null,
      thumbnailUrl: props.thumbnailUrl?.trim() ?? null,
      downloadCount: props.downloadCount ?? 0,
      fileCount: props.fileCount ?? files.length,
      tags,
      files,
      spaceId: props.spaceId ?? null,
      createdById: props.createdById ?? null,
      createdAt: props.createdAt ?? new Date(),
      updatedAt: props.updatedAt ?? new Date(),
    });
  }

  public toSummary(): TemplateSummaryView {
    return {
      id: this.id,
      slug: this.slug,
      versionId: this.versionId,
      name: this.name,
      category: this.category,
      visibility: this.visibility,
      description: this.description,
      compiler: this.compiler,
      texLiveVersion: this.texLiveVersion,
      mainFile: this.mainFile,
      badge: this.badge,
      author: this.author,
      license: this.license,
      sourceUrl: this.sourceUrl,
      thumbnailUrl: this.thumbnailUrl,
      downloadCount: this.downloadCount,
      fileCount: this.fileCount,
      tags: [...this.tags],
      spaceId: this.spaceId,
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

  /** GoF Prototype `clone()`: Produces an isolated hydration plan for a target workspace. */
  public clonePlan(customTitle?: string): WorkspaceClonePlan {
    return {
      templateId: this.id,
      versionId: this.versionId,
      title: (customTitle?.trim() || this.name).slice(0, 255),
      compiler: this.compiler,
      texLiveVersion: this.texLiveVersion,
      mainFile: this.mainFile,
      files: this.files.map((f) => {
        const parts = f.path.split('/');
        const name = parts[parts.length - 1];
        const dir = parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : '/';
        return {
          path: f.path,
          projectPath: `/${f.path}`,
          name,
          dir,
          kind: f.kind,
          mimeType: f.mimeType,
          text: f.textContent ?? undefined,
          buffer: f.toBuffer(),
        };
      }),
    };
  }
}
