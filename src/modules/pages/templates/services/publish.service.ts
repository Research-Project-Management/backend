/**
 * templates/services/publish.service.ts
 * Zero-Copy Page Template Publisher & Idempotent Republisher (`publish`):
 * - Snapshots UTF-8 text documents (`PageDoc`) and zero-copy `FileBlob` pointers (`PageFile`)
 *   without streaming S3 binaries through Node.js RAM or storing BYTEA in PostgreSQL.
 * - Strictly Space-scoped (`personal` | `project`); updates existing `PageTemplate` in place
 *   when republishing the same `sourcePageId` into the same `Space`.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import { FILES_PORT } from '@/modules/files/files.constant';
import { type IFilesPort } from '@/modules/files/types/files.type';
import {
  hydratePageDocLines,
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
  UserResolverService,
} from '@/modules/pages/core';
import { DocstoreService } from '@/modules/pages/docstore';
import {
  InvalidTemplateError,
  TemplateForbiddenError,
  TemplateNotFoundError,
} from '../domain/errors';
import { TemplateFileVo } from '../domain/file.domain';
import {
  TemplateDetailView,
  TemplateManifest,
} from '../domain/manifest.domain';
import { assertScope } from '../domain/policy';
import { PublishTemplateDto } from '../dto/template.dto';
import { TemplatesRepository } from '../templates.repository';
import { GalleryService } from './gallery.service';

@Injectable()
export class PublishService {
  private readonly live: LiveCollaborationPort;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: TemplatesRepository,
    private readonly gallery: GalleryService,
    private readonly docstore: DocstoreService,
    @Optional()
    @Inject(FILES_PORT)
    private readonly filesPort?: IFilesPort,
    @Optional() private readonly users?: UserResolverService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
  ) {
    this.live = liveCollab ?? NOOP_LIVE_COLLABORATION;
  }

  public async publish(
    userId: string,
    dto: PublishTemplateDto,
  ): Promise<TemplateDetailView> {
    const page = await this.prisma.page.findFirst({
      where: { id: dto.pageId, deletedAt: null },
      include: { rootDoc: { select: { lastKnownPath: true } } },
    });
    if (!page) {
      throw new TemplateNotFoundError(dto.pageId);
    }

    const sourceRole = await this.gallery.getSpaceRole(page.spaceId, userId);
    if (!sourceRole) {
      throw new TemplateForbiddenError(
        'You do not have access to publish this page as a template',
      );
    }

    const isSourcePersonal =
      page.spaceId.toLowerCase() === userId.toLowerCase();
    const targetScope = dto.scope
      ? assertScope(dto.scope)
      : isSourcePersonal
        ? 'personal'
        : 'project';

    let targetSpaceId: string;

    if (targetScope === 'personal') {
      targetSpaceId = userId;
      await this.ensurePersonalSpace(userId);
    } else {
      if (isSourcePersonal) {
        throw new InvalidTemplateError(
          'A page in Personal Space cannot be published as a Project template',
        );
      }
      if (
        sourceRole !== 'owner' &&
        sourceRole !== 'coordinator' &&
        sourceRole !== 'contributor'
      ) {
        throw new TemplateForbiddenError(
          'Contributor role or higher is required to publish a Project template',
        );
      }
      targetSpaceId = page.spaceId;
    }

    const { files, blobIds } = await this.collectPageSnapshot(
      page.spaceId,
      page.id,
    );
    if (files.length === 0) {
      throw new InvalidTemplateError(
        'Source page must contain at least one LaTeX or text file',
      );
    }

    // Idempotent republish: update existing template for `(sourcePageId, targetSpaceId)` in place
    const existing = await this.repo.findBySourcePage(page.id, targetSpaceId);
    if (existing) {
      await this.gallery.assertCanManage(existing, userId);
    }

    const previousBlobIds = new Set<string>(
      (existing?.files ?? [])
        .map((f) => f.blobId)
        .filter((id): id is string => Boolean(id)),
    );
    const currentBlobIds = new Set<string>(blobIds);

    const authorName =
      existing?.author || (await this.resolveUserName(userId)) || null;
    const mainFile =
      page.rootDoc?.lastKnownPath?.replace(/^\/+/, '') || 'main.tex';

    const manifest = TemplateManifest.create({
      id: existing?.id,
      slug: existing?.slug ?? null,
      name: dto.name,
      category: dto.category ?? existing?.category,
      description: dto.description ?? page.description ?? existing?.description,
      compiler: page.compiler,
      texlive: page.texlive,
      mainFile,
      author: authorName,
      thumbnail: page.thumbnail ?? existing?.thumbnail,
      tags: dto.tags ?? existing?.tags,
      files,
      spaceId: targetSpaceId,
      spaceType: targetScope,
      sourcePageId: page.id,
      createdById: existing?.createdById ?? userId,
      createdAt: existing?.createdAt,
      updatedAt: new Date(),
    });

    let acquiredBlobIds: string[];
    let orphanedBlobIds: string[];

    if (typeof this.repo.saveWithLifecycle === 'function') {
      const saved = await this.repo.saveWithLifecycle(manifest);
      acquiredBlobIds = saved.acquiredBlobIds;
      orphanedBlobIds = saved.releasedBlobIds;
    } else {
      await this.repo.save(manifest);
      acquiredBlobIds = blobIds.filter((id) => !previousBlobIds.has(id));
      orphanedBlobIds = Array.from(previousBlobIds).filter(
        (id) => !currentBlobIds.has(id),
      );
    }

    if (
      typeof this.filesPort?.acquireBlob === 'function' &&
      acquiredBlobIds.length > 0
    ) {
      await Promise.all(
        acquiredBlobIds.map((id) =>
          Promise.resolve(this.filesPort!.acquireBlob(id)).catch(() => null),
        ),
      );
    }

    if (
      typeof this.filesPort?.releaseBlob === 'function' &&
      orphanedBlobIds.length > 0
    ) {
      await Promise.all(
        orphanedBlobIds.map((id) =>
          Promise.resolve(this.filesPort!.releaseBlob(id)).catch(() => null),
        ),
      );
    }

    return manifest.toDetail();
  }

  private async collectPageSnapshot(
    spaceId: string,
    pageId: string,
  ): Promise<{ files: TemplateFileVo[]; blobIds: string[] }> {
    const nodes = await this.prisma.pageNode.findMany({
      where: { spaceId, pageId },
      orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }],
    });

    const docIds = nodes.filter((n) => Boolean(n.docId)).map((n) => n.docId!);
    if (docIds.length > 0) {
      await this.live.flushDocs(spaceId, docIds).catch(() => []);
    }

    const [docs, binaryFiles] = await Promise.all([
      this.prisma.pageDoc.findMany({
        where: { spaceId, pageId, deletedAt: null },
      }),
      this.prisma.pageFile.findMany({
        where: { spaceId, pageId, deletedAt: null },
      }),
    ]);

    const docTextById = new Map<string, string>();
    for (const doc of docs) {
      const lines = doc.inStorage
        ? await hydratePageDocLines(this.docstore, doc)
        : Array.isArray(doc.lines)
          ? (doc.lines as string[])
          : [];
      docTextById.set(doc.id, lines.join('\n'));
    }

    const fileById = new Map(binaryFiles.map((f) => [f.id, f]));
    const collected: TemplateFileVo[] = [];
    const blobIds = new Set<string>();

    for (const node of nodes) {
      if (node.type === 'FOLDER' || node.path === '/') continue;
      const relPath = (node.path || node.name || '').replace(/^\/+/, '');
      if (!relPath) continue;

      if (node.type === 'DOC' && node.docId) {
        const text = docTextById.get(node.docId);
        if (text !== undefined) {
          collected.push(TemplateFileVo.fromText(relPath, text));
        }
      } else if (node.type === 'FILE' && node.fileId) {
        const pf = fileById.get(node.fileId);
        if (pf && pf.storageKey) {
          collected.push(
            TemplateFileVo.fromAssetRef(relPath, {
              blobId: pf.blobId,
              storageKey: pf.storageKey,
              bucketName: pf.bucketName,
              contentHash: pf.hash,
              mimeType: pf.mimeType,
              sizeBytes: pf.sizeBytes,
            }),
          );
          if (pf.blobId) blobIds.add(pf.blobId);
        }
      }
    }

    return { files: collected, blobIds: Array.from(blobIds) };
  }

  private async ensurePersonalSpace(userId: string): Promise<void> {
    if (!isUuid(userId) || !this.prisma.space?.upsert) return;
    await this.prisma.space
      .upsert({
        where: { id: userId },
        create: { id: userId, type: 'personal', ownerUserId: userId },
        update: {},
      })
      .catch(() => undefined);
  }

  private async resolveUserName(userId: string): Promise<string | null> {
    if (!this.users || !isUuid(userId)) return null;
    const map = await this.users.resolveUserNames([userId]).catch(() => null);
    return map?.get(userId)?.name ?? null;
  }
}
