/**
 * templates/templates.repository.ts
 * BCNF Prisma Repository for `TemplateBlob`, `PageTemplate`, `PageTemplateFile`, `PageTemplateTag`:
 * - Single-flight lazy seeding of `OFFICIAL_TEMPLATES` into PostgreSQL so SQL handles 100% of
 *   filtering, sorting, pagination, and `downloadCount` increments (zero dual-source RAM merge!).
 * - Virtual Proxy summary queries (`findSummaries`) that never load `TemplateBlob` payloads.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import { OFFICIAL_TEMPLATES } from './domain/catalog.domain';
import { TemplateFileVo } from './domain/file.domain';
import { TemplateManifest } from './domain/manifest.domain';
import { TemplateCategory, TemplateVisibility } from './domain/policy';

export interface BrowseTemplatesFilter {
  readonly userId?: string;
  readonly spaceId?: string;
  readonly category?: TemplateCategory;
  readonly visibility?: TemplateVisibility;
  readonly tag?: string;
  readonly search?: string;
  readonly limit: number;
  readonly offset: number;
}

@Injectable()
export class TemplatesRepository {
  private seedPromise: Promise<void> | null = null;
  private seeded = false;

  constructor(private readonly prisma: PrismaService) {}

  private ensureSeeded(): Promise<void> {
    if (this.seeded) return Promise.resolve();
    if (this.seedPromise) return this.seedPromise;

    this.seedPromise = (async () => {
      try {
        const count = await this.prisma.pageTemplate.count({
          where: { visibility: 'official' },
        });
        if (count < OFFICIAL_TEMPLATES.length) {
          for (const tmpl of OFFICIAL_TEMPLATES) {
            await this.save(tmpl);
          }
        }
        this.seeded = true;
      } finally {
        this.seedPromise = null;
      }
    })();

    return this.seedPromise;
  }

  public async findSummaries(
    filter: BrowseTemplatesFilter,
  ): Promise<{ items: TemplateManifest[]; total: number }> {
    await this.ensureSeeded();

    const where = this.buildWhereClause(filter);
    const [total, rows] = await Promise.all([
      this.prisma.pageTemplate.count({ where }),
      this.prisma.pageTemplate.findMany({
        where,
        include: {
          tags: { select: { tag: true } },
          _count: { select: { files: true } },
        },
        orderBy: [{ downloadCount: 'desc' }, { createdAt: 'desc' }],
        skip: filter.offset,
        take: filter.limit,
      }),
    ]);

    const items = rows.map((r) =>
      TemplateManifest.create({
        id: r.id,
        slug: r.slug,
        versionId: r.versionId,
        name: r.name,
        category: r.category,
        visibility: r.visibility,
        description: r.description,
        compiler: r.compiler,
        texLiveVersion: r.texLiveVersion,
        mainFile: r.mainFile,
        badge: r.badge,
        author: r.author,
        license: r.license,
        sourceUrl: r.sourceUrl,
        thumbnailUrl: r.thumbnailUrl,
        downloadCount: r.downloadCount,
        fileCount: r._count.files,
        tags: r.tags.map((t) => t.tag),
        spaceId: r.spaceId,
        createdById: r.createdById,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }),
    );

    return { items, total };
  }

  /** Loads full `TemplateManifest` + `TemplateBlob` payloads by canonical UUID or `slug`. */
  public async findDetail(
    identifier: string,
  ): Promise<TemplateManifest | null> {
    const clean = identifier?.trim();
    if (!clean) return null;

    await this.ensureSeeded();

    const where: Prisma.PageTemplateWhereInput = isUuid(clean)
      ? { id: clean }
      : { slug: clean.toLowerCase() };

    const row = await this.prisma.pageTemplate.findFirst({
      where,
      include: {
        tags: { select: { tag: true } },
        files: {
          include: { blob: true },
          orderBy: { pathname: 'asc' },
        },
      },
    });

    if (!row) return null;

    const files = row.files.map((f) =>
      f.kind === 'file' && f.blob.binaryData
        ? TemplateFileVo.fromBuffer(
            f.pathname,
            Buffer.from(f.blob.binaryData),
            f.blob.mimeType,
          )
        : TemplateFileVo.fromText(f.pathname, f.blob.textContent ?? ''),
    );

    return TemplateManifest.create({
      id: row.id,
      slug: row.slug,
      versionId: row.versionId,
      name: row.name,
      category: row.category,
      visibility: row.visibility,
      description: row.description,
      compiler: row.compiler,
      texLiveVersion: row.texLiveVersion,
      mainFile: row.mainFile,
      badge: row.badge,
      author: row.author,
      license: row.license,
      sourceUrl: row.sourceUrl,
      thumbnailUrl: row.thumbnailUrl,
      downloadCount: row.downloadCount,
      fileCount: files.length,
      tags: row.tags.map((t) => t.tag),
      files,
      spaceId: row.spaceId,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  /** Atomically persists `TemplateManifest` across the 4 BCNF tables. */
  public async save(manifest: TemplateManifest): Promise<TemplateManifest> {
    await this.prisma.$transaction(async (tx) => {
      // 1. Upsert deduplicated CAS blobs (skipDuplicates on PK `content_hash`)
      if (manifest.files.length > 0) {
        const uniqueBlobs = new Map<string, TemplateFileVo>();
        for (const f of manifest.files) {
          uniqueBlobs.set(f.contentHash, f);
        }
        await tx.templateBlob.createMany({
          data: Array.from(uniqueBlobs.values()).map((b) => ({
            contentHash: b.contentHash,
            textContent: b.textContent,
            binaryData: b.binaryData ? new Uint8Array(b.binaryData) : null,
            mimeType: b.mimeType,
            sizeBytes: b.sizeBytes,
          })),
          skipDuplicates: true,
        });
      }

      // 2. Upsert aggregate root `PageTemplate`
      const coreData = {
        slug: manifest.slug,
        versionId: manifest.versionId,
        name: manifest.name,
        category: manifest.category,
        visibility: manifest.visibility,
        description: manifest.description,
        compiler: manifest.compiler,
        texLiveVersion: manifest.texLiveVersion,
        mainFile: manifest.mainFile,
        badge: manifest.badge,
        author: manifest.author,
        license: manifest.license,
        sourceUrl: manifest.sourceUrl,
        thumbnailUrl: manifest.thumbnailUrl,
        spaceId: manifest.spaceId,
        createdById: manifest.createdById,
      };

      await tx.pageTemplate.upsert({
        where: { id: manifest.id },
        create: {
          id: manifest.id,
          ...coreData,
          downloadCount: manifest.downloadCount,
        },
        update: coreData,
      });

      // 3. Replace normalized file tree & 1NF tags when files/tags provided
      if (manifest.files.length > 0) {
        await tx.pageTemplateFile.deleteMany({
          where: { templateId: manifest.id },
        });
        await tx.pageTemplateFile.createMany({
          data: manifest.files.map((f) => ({
            templateId: manifest.id,
            pathname: f.path,
            kind: f.kind,
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

  public async deleteById(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const res = await this.prisma.pageTemplate.deleteMany({ where: { id } });
    return res.count > 0;
  }

  public async incrementDownloads(id: string): Promise<void> {
    if (!isUuid(id)) return;
    await this.prisma.pageTemplate
      .update({
        where: { id },
        data: { downloadCount: { increment: 1 } },
      })
      .catch(() => undefined);
  }

  private buildWhereClause(
    filter: BrowseTemplatesFilter,
  ): Prisma.PageTemplateWhereInput {
    const conditions: Prisma.PageTemplateWhereInput[] = [];

    if (filter.visibility) {
      if (filter.visibility === 'official') {
        conditions.push({ visibility: 'official' });
      } else if (filter.visibility === 'private') {
        conditions.push({
          visibility: 'private',
          createdById: filter.userId ?? '__none__',
        });
      } else if (filter.visibility === 'workspace') {
        conditions.push({
          visibility: 'workspace',
          ...(filter.spaceId ? { spaceId: filter.spaceId } : {}),
        });
      }
    } else {
      const allowedScopes: Prisma.PageTemplateWhereInput[] = [
        { visibility: 'official' },
      ];
      if (filter.userId && isUuid(filter.userId)) {
        allowedScopes.push({
          visibility: 'private',
          createdById: filter.userId,
        });
      }
      if (filter.spaceId && isUuid(filter.spaceId)) {
        allowedScopes.push({
          visibility: 'workspace',
          spaceId: filter.spaceId,
        });
      }
      conditions.push({ OR: allowedScopes });
    }

    if (filter.category) {
      conditions.push({ category: filter.category });
    }

    if (filter.tag?.trim()) {
      conditions.push({
        tags: { some: { tag: filter.tag.trim().toLowerCase() } },
      });
    }

    const q = filter.search?.trim();
    if (q) {
      conditions.push({
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
          { author: { contains: q, mode: 'insensitive' } },
          { badge: { contains: q, mode: 'insensitive' } },
          { tags: { some: { tag: { contains: q.toLowerCase() } } } },
        ],
      });
    }

    return conditions.length === 1 ? conditions[0] : { AND: conditions };
  }
}
