/**
 * templates/templates.repository.ts
 * BCNF Prisma Repository (`TemplateBlob`, `PageTemplate`, `PageTemplateFile`, `PageTemplateTag`):
 * - Strictly Space-scoped (`spaceId: string` -> `personal` | `project` Space, matching `CitationStyle` & `Page`).
 * - Zero write-on-read seeding (`BUILTIN_TEMPLATES` live purely in domain catalog).
 * - Zero binary bytes in PostgreSQL: binary assets reference platform `FileBlob` CAS.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import { TemplateFileVo } from './domain/file.domain';
import { TemplateManifest } from './domain/manifest.domain';
import { TemplateCategory, TemplateScope } from './domain/policy';

export interface BrowseTemplatesFilter {
  readonly userId: string;
  readonly projectSpaceId?: string;
  readonly category?: TemplateCategory;
  readonly scope?: TemplateScope;
  readonly search?: string;
  readonly limit: number;
  readonly offset: number;
}

@Injectable()
export class TemplatesRepository {
  constructor(private readonly prisma: PrismaService) {}

  public async findSummaries(
    filter: BrowseTemplatesFilter,
  ): Promise<{ items: TemplateManifest[]; total: number }> {
    const where = this.buildWhereClause(filter);
    if (!where) return { items: [], total: 0 };

    const [total, rows] = await Promise.all([
      this.prisma.pageTemplate.count({ where }),
      this.prisma.pageTemplate.findMany({
        where,
        include: {
          space: { select: { type: true } },
          createdBy: {
            select: {
              email: true,
              profile: { select: { name: true } },
            },
          },
          tags: { select: { tag: true } },
          _count: { select: { files: true } },
        },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
        skip: filter.offset,
        take: filter.limit,
      }),
    ]);

    const items = rows.map((r) =>
      TemplateManifest.create({
        id: r.id,
        slug: r.slug,
        name: r.name,
        category: r.category,
        description: r.description,
        compiler: r.compiler,
        texlive: r.texlive,
        mainFile: r.mainFile,
        author:
          r.createdBy?.profile?.name ||
          r.createdBy?.email?.split('@')[0] ||
          null,
        thumbnail: r.thumbnail,
        fileCount: r._count.files,
        tags: r.tags.map((t) => t.tag),
        spaceId: r.spaceId,
        spaceType: r.space?.type ?? null,
        sourcePageId: r.sourcePageId,
        createdById: r.createdById,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }),
    );

    return { items, total };
  }

  /** Loads full Space-owned `TemplateManifest` + `TemplateBlob` payloads by UUID or `slug`. */
  public async findDetail(
    identifier: string,
    allowedSpaceIds?: readonly string[],
  ): Promise<TemplateManifest | null> {
    const clean = identifier?.trim();
    if (!clean) return null;

    if (isUuid(clean)) {
      return this.findFirstManifest({ id: clean });
    }

    const spaces = (allowedSpaceIds ?? []).filter((id) => isUuid(id));
    if (spaces.length === 0) return null;

    return this.findFirstManifest({
      slug: clean.toLowerCase(),
      spaceId: { in: spaces },
    });
  }

  public async findBySourcePage(
    sourcePageId: string,
    spaceId: string,
  ): Promise<TemplateManifest | null> {
    if (!isUuid(sourcePageId) || !isUuid(spaceId)) return null;
    return this.findFirstManifest({ sourcePageId, spaceId });
  }

  private async findFirstManifest(
    where: Prisma.PageTemplateWhereInput,
  ): Promise<TemplateManifest | null> {
    const row = await this.prisma.pageTemplate.findFirst({
      where,
      include: {
        space: { select: { type: true } },
        createdBy: {
          select: {
            email: true,
            profile: { select: { name: true } },
          },
        },
        tags: { select: { tag: true } },
        files: {
          include: { blob: true },
          orderBy: { pathname: 'asc' },
        },
      },
    });

    if (!row) return null;

    const files = row.files.map((f) =>
      f.type === 'FILE' && f.blob.storageKey
        ? TemplateFileVo.fromAssetRef(f.pathname, {
            blobId: f.blob.blobId,
            storageKey: f.blob.storageKey,
            bucketName: f.blob.bucketName,
            contentHash: f.blob.contentHash,
            mimeType: f.blob.mimeType,
            sizeBytes: f.blob.sizeBytes,
          })
        : TemplateFileVo.fromText(f.pathname, f.blob.textContent ?? ''),
    );

    return TemplateManifest.create({
      id: row.id,
      slug: row.slug,
      name: row.name,
      category: row.category,
      description: row.description,
      compiler: row.compiler,
      texlive: row.texlive,
      mainFile: row.mainFile,
      author:
        row.createdBy?.profile?.name ||
        row.createdBy?.email?.split('@')[0] ||
        null,
      thumbnail: row.thumbnail,
      fileCount: files.length,
      tags: row.tags.map((t) => t.tag),
      files,
      spaceId: row.spaceId,
      spaceType: row.space?.type ?? null,
      sourcePageId: row.sourcePageId,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  /** Atomically persists Space-owned `TemplateManifest` across the 4 BCNF tables. */
  public async save(manifest: TemplateManifest): Promise<TemplateManifest> {
    if (!manifest.spaceId || !manifest.createdById) {
      throw new Error('Persisted PageTemplate requires spaceId and createdById');
    }
    const spaceId = manifest.spaceId;
    const createdById = manifest.createdById;

    await this.prisma.$transaction(async (tx) => {
      if (manifest.files.length > 0) {
        const uniqueBlobs = new Map<string, TemplateFileVo>();
        for (const f of manifest.files) {
          uniqueBlobs.set(f.contentHash, f);
        }
        await tx.templateBlob.createMany({
          data: Array.from(uniqueBlobs.values()).map((b) => ({
            contentHash: b.contentHash,
            textContent: b.textContent,
            blobId: b.blobId,
            storageKey: b.storageKey,
            bucketName: b.bucketName,
            mimeType: b.mimeType,
            sizeBytes: b.sizeBytes,
          })),
          skipDuplicates: true,
        });
      }

      const coreData = {
        spaceId,
        sourcePageId: manifest.sourcePageId,
        createdById,
        slug: manifest.slug,
        name: manifest.name,
        category: manifest.category,
        description: manifest.description,
        compiler: manifest.compiler,
        texlive: manifest.texlive,
        mainFile: manifest.mainFile,
        thumbnail: manifest.thumbnail,
      };

      await tx.pageTemplate.upsert({
        where: { id: manifest.id },
        create: {
          id: manifest.id,
          ...coreData,
        },
        update: coreData,
      });

      if (manifest.files.length > 0) {
        await tx.pageTemplateFile.deleteMany({
          where: { templateId: manifest.id },
        });
        await tx.pageTemplateFile.createMany({
          data: manifest.files.map((f) => ({
            templateId: manifest.id,
            pathname: f.path,
            type: f.type,
            contentHash: f.contentHash,
          })),
        });
      }

      await tx.pageTemplateTag.deleteMany({
        where: { templateId: manifest.id },
      });
      if (manifest.tags.length > 0) {
        await tx.pageTemplateTag.createMany({
          data: manifest.tags.map((tag) => ({
            templateId: manifest.id,
            tag,
          })),
          skipDuplicates: true,
        });
      }
    });

    return manifest;
  }

  public async deleteById(id: string): Promise<{ deleted: boolean; releasedBlobIds: string[] }> {
    if (!isUuid(id)) return { deleted: false, releasedBlobIds: [] };

    return this.prisma.$transaction(async (tx) => {
      const res = await tx.pageTemplate.deleteMany({ where: { id } });
      if (res.count === 0) {
        return { deleted: false, releasedBlobIds: [] };
      }

      const orphans = tx.templateBlob?.findMany
        ? await tx.templateBlob.findMany({
            where: { templateFiles: { none: {} } },
            select: { contentHash: true, blobId: true },
          })
        : [];

      const releasedBlobIds = orphans
        .map((o) => o.blobId)
        .filter((b): b is string => Boolean(b));

      if (orphans.length > 0 && tx.templateBlob?.deleteMany) {
        await tx.templateBlob.deleteMany({
          where: { contentHash: { in: orphans.map((o) => o.contentHash) } },
        });
      }

      return { deleted: true, releasedBlobIds };
    });
  }

  private buildWhereClause(
    filter: BrowseTemplatesFilter,
  ): Prisma.PageTemplateWhereInput | null {
    const personalSpaceId = isUuid(filter.userId) ? filter.userId : null;
    const projectSpaceId =
      filter.projectSpaceId &&
      isUuid(filter.projectSpaceId) &&
      filter.projectSpaceId.toLowerCase() !== personalSpaceId?.toLowerCase()
        ? filter.projectSpaceId
        : null;

    const conditions: Prisma.PageTemplateWhereInput[] = [];

    if (filter.scope === 'personal') {
      if (!personalSpaceId) return null;
      conditions.push({ spaceId: personalSpaceId });
    } else if (filter.scope === 'project') {
      if (!projectSpaceId) return null;
      conditions.push({ spaceId: projectSpaceId });
    } else {
      const allowedSpaces = [personalSpaceId, projectSpaceId].filter(
        (id): id is string => Boolean(id),
      );
      if (allowedSpaces.length === 0) return null;
      conditions.push({
        spaceId:
          allowedSpaces.length === 1 ? allowedSpaces[0] : { in: allowedSpaces },
      });
    }

    if (filter.category) {
      conditions.push({ category: filter.category });
    }

    const q = filter.search?.trim();
    if (q) {
      conditions.push({
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { slug: { contains: q.toLowerCase() } },
          { description: { contains: q, mode: 'insensitive' } },
          { tags: { some: { tag: { contains: q.toLowerCase() } } } },
        ],
      });
    }

    return conditions.length === 1 ? conditions[0] : { AND: conditions };
  }
}
