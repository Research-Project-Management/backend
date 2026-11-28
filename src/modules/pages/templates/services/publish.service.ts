/**
 * templates/services/publish.service.ts
 * Full-Fidelity Workspace Publisher (`publish`):
 * Snapshots BOTH UTF-8 text documents (`DocstoreService`) AND binary assets (`FilestoreService`:
 * `.png`, `.pdf`, `.jpg`, `.ttf`, `.otf`) from a live manuscript into an immutable `TemplateManifest`.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { Readable } from 'node:stream';
import { mapWithConcurrency, PrismaService, isUuid } from '@/core';
import { AccessConfigService } from '@/modules/project/access';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import { StructureService } from '@/modules/pages/structure/structure.service';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
} from '@/modules/pages/core/ports/live-collaboration.port';
import { UserResolverService } from '@/modules/pages/core/services/user-resolver.service';
import { InvalidTemplateError, TemplateForbiddenError } from '../domain/errors';
import { TemplateFileVo } from '../domain/file.domain';
import {
  TemplateDetailView,
  TemplateManifest,
} from '../domain/manifest.domain';
import { assertVisibility } from '../domain/policy';
import { PublishTemplateDto } from '../dto/template.dto';
import { TemplatesRepository } from '../templates.repository';
import { GalleryService } from './gallery.service';

const COLLECT_CONCURRENCY = 6;

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

@Injectable()
export class PublishService {
  private readonly live: LiveCollaborationPort;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: TemplatesRepository,
    private readonly gallery: GalleryService,
    private readonly structure: StructureService,
    private readonly docstore: DocstoreService,
    private readonly filestore: FilestoreService,
    @Optional() private readonly accessConfig?: AccessConfigService,
    @Optional() private readonly users?: UserResolverService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
  ) {
    this.live = liveCollab ?? NOOP_LIVE_COLLABORATION;
  }

  /**
   * Publishes a new template (`private`, `workspace`, or operator-only `official`)
   * from inline files and/or by snapshotting a live `(spaceId, pageId)` workspace
   * (including binary images/fonts in `FilestoreService`).
   */
  public async publish(
    userId: string,
    dto: PublishTemplateDto,
  ): Promise<TemplateDetailView> {
    const visibility = assertVisibility(dto.visibility);
    const isOp = this.accessConfig?.isOperator(userId) ?? false;

    if (visibility === 'official' && !isOp) {
      throw new TemplateForbiddenError(
        'Only platform operators can publish official gallery templates',
      );
    }

    let sourceSpaceId = dto.spaceId;
    const sourcePageId = dto.pageId;
    let pageMeta: {
      spaceId: string;
      compiler: string;
      texLiveVersion: string;
      mainFile?: string;
    } | null = null;

    if (sourcePageId && isUuid(sourcePageId)) {
      const page = await this.prisma.page.findFirst({
        where: { id: sourcePageId, deletedAt: null },
        include: { rootDoc: { select: { lastKnownPath: true } } },
      });
      if (page) {
        sourceSpaceId = page.spaceId;
        pageMeta = {
          spaceId: page.spaceId,
          compiler: page.compiler,
          texLiveVersion: page.texlive,
          mainFile: page.rootDoc?.lastKnownPath?.replace(/^\/+/, ''),
        };
      }
    }

    if (sourceSpaceId) {
      const canRead = await this.gallery.hasSpaceAccess(
        sourceSpaceId,
        userId,
        visibility === 'workspace',
      );
      if (!canRead) {
        throw new TemplateForbiddenError(
          'You do not have access to snapshot the specified workspace',
        );
      }
    } else if (visibility === 'workspace') {
      throw new InvalidTemplateError(
        'spaceId is required when publishing a workspace-scoped template',
      );
    }

    const fileMap = new Map<string, TemplateFileVo>();

    if (sourceSpaceId) {
      const collected = await this.collectWorkspaceFiles(
        sourceSpaceId,
        sourcePageId,
      );
      for (const f of collected) {
        fileMap.set(f.path, f);
      }
    }

    if (dto.files) {
      for (const [rawPath, content] of Object.entries(dto.files)) {
        const vo = TemplateFileVo.fromText(rawPath, String(content ?? ''));
        fileMap.set(vo.path, vo);
      }
    }

    if (fileMap.size === 0) {
      throw new InvalidTemplateError(
        'Template must contain at least one LaTeX or text file',
      );
    }

    const authorName =
      dto.author?.trim() || (await this.resolveUserName(userId)) || 'Author';

    const manifest = TemplateManifest.create({
      name: dto.name,
      category: dto.category,
      visibility,
      description: dto.description,
      compiler: dto.compiler || pageMeta?.compiler || 'pdflatex',
      texLiveVersion: dto.texLiveVersion || pageMeta?.texLiveVersion || '2024',
      mainFile: dto.mainFile || pageMeta?.mainFile || 'main.tex',
      author: authorName,
      license: dto.license,
      sourceUrl: dto.sourceUrl,
      thumbnailUrl: dto.thumbnailUrl,
      tags: dto.tags,
      files: Array.from(fileMap.values()),
      spaceId: visibility === 'workspace' ? (sourceSpaceId ?? null) : null,
      createdById: userId,
    });

    await this.repo.save(manifest);
    return manifest.toDetail();
  }

  private async collectWorkspaceFiles(
    spaceId: string,
    pageId?: string,
  ): Promise<TemplateFileVo[]> {
    const nodes = await this.structure
      .getAllNodes(spaceId, undefined, pageId)
      .catch(() => []);

    const docIds = nodes.filter((n) => Boolean(n.docId)).map((n) => n.docId!);
    if (docIds.length > 0) {
      await this.live.flushDocs(spaceId, docIds).catch(() => []);
    }

    const docsList = await this.docstore
      .getAllDocs(spaceId, pageId)
      .catch(() => []);
    const docsById = new Map(
      docsList.map((d) => [d._id, (d.lines || []).join('\n')]),
    );

    const leaves = nodes.filter((n) => n.type !== 'FOLDER' && n.path !== '/');
    const collected = await mapWithConcurrency(
      leaves,
      COLLECT_CONCURRENCY,
      async (node): Promise<TemplateFileVo | null> => {
        const relPath = (node.path || node.name || '').replace(/^\/+/, '');
        if (!relPath) return null;

        if (node.docId) {
          const text = docsById.get(node.docId);
          if (text === undefined) return null;
          return TemplateFileVo.fromText(relPath, text);
        }

        if (node.fileId) {
          try {
            const { file, stream } = await this.filestore.openReadStream(
              spaceId,
              node.fileId,
            );
            const buf = await streamToBuffer(stream);
            return TemplateFileVo.fromBuffer(relPath, buf, file?.mimeType);
          } catch {
            return null;
          }
        }
        return null;
      },
    );

    return collected.filter((f): f is TemplateFileVo => f !== null);
  }

  private async resolveUserName(userId: string): Promise<string | null> {
    if (!this.users || !isUuid(userId)) return null;
    const map = await this.users.resolveUserNames([userId]).catch(() => null);
    return map?.get(userId)?.name ?? null;
  }
}
