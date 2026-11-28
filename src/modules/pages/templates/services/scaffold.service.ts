/**
 * templates/services/scaffold.service.ts
 * GoF Prototype Workspace Hydrator (`scaffold`):
 * Clones a `TemplateManifest` Prototype into an existing `Page` or newly created `Page`,
 * applying `compiler`, `texlive`, `rootDocId`, and provenance with `SagaRunner` compensation.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { mapWithConcurrency, PrismaService, isUuid } from '@/core';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { FilestoreService } from '@/modules/pages/filestore/filestore.service';
import { StructureService } from '@/modules/pages/structure/structure.service';
import {
  LIVE_COLLABORATION_PORT,
  LiveCollaborationPort,
  NOOP_LIVE_COLLABORATION,
} from '@/modules/pages/core/ports/live-collaboration.port';
import { PageDomainEventBus } from '@/modules/pages/core/events/event-bus.service';
import { SagaRunner } from '@/modules/pages/core/utils/saga-runner';
import { ScaffoldTemplateDto } from '../dto/template.dto';
import { TemplatesRepository } from '../templates.repository';
import { GalleryService } from './gallery.service';

const HYDRATE_CONCURRENCY = 6;

export interface ScaffoldResult {
  readonly pageId: string;
  readonly rootDocId: string | null;
  readonly compiler: string;
  readonly mainFile: string;
  readonly importedDocs: number;
  readonly importedFiles: number;
  readonly totalEntries: number;
}

function countSlashes(p: string): number {
  let count = 0;
  for (let i = 0; i < p.length; i++) {
    if (p.charCodeAt(i) === 47) count++;
  }
  return count;
}

@Injectable()
export class ScaffoldService {
  private readonly logger = new Logger(ScaffoldService.name);
  private readonly live: LiveCollaborationPort;
  private readonly eventBus: PageDomainEventBus;

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: TemplatesRepository,
    private readonly gallery: GalleryService,
    private readonly structure: StructureService,
    private readonly docstore: DocstoreService,
    private readonly filestore: FilestoreService,
    @Optional()
    @Inject(LIVE_COLLABORATION_PORT)
    liveCollab?: LiveCollaborationPort,
    @Optional() eventBus?: PageDomainEventBus,
  ) {
    this.live = liveCollab ?? NOOP_LIVE_COLLABORATION;
    this.eventBus = eventBus ?? new PageDomainEventBus(this.live);
  }

  public async scaffold(
    spaceId: string,
    templateKey: string,
    userId: string,
    dto?: ScaffoldTemplateDto,
  ): Promise<ScaffoldResult> {
    const manifest = await this.gallery.getAuthorizedManifest(
      templateKey,
      userId,
    );
    const plan = manifest.clonePlan(dto?.title);

    const saga = new SagaRunner({
      logger: this.logger,
      contextName: `ScaffoldService.scaffold(${spaceId}, ${manifest.id})`,
    });

    let targetPageId = dto?.pageId?.trim() || '';
    let createdNewPage = false;

    try {
      if (targetPageId) {
        const existingPage = await this.prisma.page.findFirst({
          where: { id: targetPageId, deletedAt: null },
          select: { id: true, settings: true },
        });
        if (existingPage) {
          const prevSettings =
            existingPage.settings &&
            typeof existingPage.settings === 'object' &&
            !Array.isArray(existingPage.settings)
              ? (existingPage.settings as Record<string, unknown>)
              : {};
          await this.prisma.page.update({
            where: { id: existingPage.id },
            data: {
              compiler: plan.compiler,
              texlive: plan.texLiveVersion,
              settings: {
                ...prevSettings,
                fromTemplateId: plan.templateId,
                fromTemplateVersionId: plan.versionId,
              },
            },
          });
        }
      } else {
        targetPageId = randomUUID();
        createdNewPage = true;
        await this.ensurePersonalSpace(spaceId, userId);

        await saga.step(
          `createPage:${targetPageId}`,
          async () => {
            await this.prisma.page.create({
              data: {
                id: targetPageId,
                spaceId,
                title: plan.title,
                compiler: plan.compiler,
                texlive: plan.texLiveVersion,
                createdById: userId,
                settings: {
                  fromTemplateId: plan.templateId,
                  fromTemplateVersionId: plan.versionId,
                },
              },
            });
          },
          async () => {
            await this.prisma.page
              .delete({ where: { id: targetPageId } })
              .catch(() => undefined);
          },
        );
      }

      const existingNodes = createdNewPage
        ? []
        : await this.structure
            .getAllNodes(spaceId, undefined, targetPageId)
            .catch(() => []);

      if (!createdNewPage && existingNodes.length > 0) {
        const docIds = existingNodes
          .filter((n) => Boolean(n.docId))
          .map((n) => n.docId!);
        if (docIds.length > 0) {
          await this.live.flushDocs(spaceId, docIds).catch(() => []);
        }
      }

      const nodesByPath = new Map(existingNodes.map((n) => [n.path, n]));
      const folderIdByDir = new Map<string, string | null>([['/', null]]);
      for (const n of existingNodes) {
        if (n.type === 'FOLDER' && n.path) folderIdByDir.set(n.path, n.id);
      }

      const uniqueDirs = Array.from(
        new Set(plan.files.map((f) => f.dir).filter((d) => d !== '/')),
      ).sort((a, b) => countSlashes(a) - countSlashes(b));

      for (const dir of uniqueDirs) {
        if (folderIdByDir.has(dir)) continue;
        const createdDir = await this.structure.mkdirp(
          spaceId,
          dir,
          targetPageId,
        );
        folderIdByDir.set(dir, createdDir?.id ?? null);
      }

      let importedDocs = 0;
      let importedFiles = 0;
      let rootNodeId: string | null = null;
      let rootDocId: string | null = null;

      await mapWithConcurrency(
        plan.files,
        HYDRATE_CONCURRENCY,
        async (entry) => {
          const isMain = entry.path === plan.mainFile;
          const parentId = folderIdByDir.get(entry.dir) ?? null;
          const existing = nodesByPath.get(entry.projectPath);

          if (entry.kind === 'doc') {
            const lines = (entry.text ?? '').split('\n');
            if (existing?.docId) {
              const cur = await this.docstore
                .getDoc(spaceId, existing.docId)
                .catch(() => null);
              const rev = (cur?.version ?? 0) + 1;
              await this.docstore.updateDoc(spaceId, existing.docId, {
                lines,
                version: rev,
              });
              await this.eventBus.publish({
                type: 'manuscript.document.mutated',
                projectId: spaceId,
                docId: existing.docId,
                lines,
                version: rev,
                source: 'template-hydration',
                occurredAt: Date.now(),
              });
              importedDocs += 1;
              if (isMain) {
                rootNodeId = existing.id;
                rootDocId = existing.docId;
              }
              return;
            }

            if (existing) {
              await this.structure
                .deleteNode(spaceId, existing.id)
                .catch(() => undefined);
            }

            const doc = await this.docstore.createDoc(spaceId, {
              ...(createdNewPage && isMain ? { id: targetPageId } : {}),
              path: entry.projectPath,
              lines,
              version: 1,
              pageId: targetPageId,
            });

            const node = await this.structure.createNode(
              spaceId,
              {
                name: entry.name,
                path: entry.projectPath,
                parentId,
                type: 'DOC',
                docId: doc._id,
                isRootDoc: isMain,
                pageId: targetPageId,
              },
              targetPageId,
            );

            await this.eventBus.publish({
              type: 'manuscript.document.mutated',
              projectId: spaceId,
              docId: doc._id,
              lines,
              version: 1,
              source: 'template-hydration',
              occurredAt: Date.now(),
            });

            importedDocs += 1;
            if (isMain) {
              rootNodeId = node.id;
              rootDocId = doc._id;
            }
          } else {
            if (existing) {
              if (existing.fileId) {
                await this.filestore
                  .deleteFile(spaceId, existing.fileId, false)
                  .catch(() => undefined);
              }
              await this.structure
                .deleteNode(spaceId, existing.id)
                .catch(() => undefined);
            }

            const uploaded = await this.filestore.uploadFileFromBuffer(
              spaceId,
              entry.path,
              entry.buffer,
              entry.mimeType,
              { pageId: targetPageId },
            );

            await this.structure.createNode(
              spaceId,
              {
                name: entry.name,
                path: entry.projectPath,
                parentId,
                type: 'FILE',
                fileId: uploaded.id,
                pageId: targetPageId,
              },
              targetPageId,
            );
            importedFiles += 1;
          }
        },
      );

      if (rootNodeId) {
        await this.structure
          .setRootDoc(spaceId, rootNodeId)
          .catch(() => undefined);
      }
      if (rootDocId) {
        await this.prisma.page
          .update({
            where: { id: targetPageId },
            data: { rootDocId },
          })
          .catch(() => undefined);
      }

      void this.repo.incrementDownloads(manifest.id);

      return {
        pageId: targetPageId,
        rootDocId: rootDocId ?? targetPageId,
        compiler: plan.compiler,
        mainFile: plan.mainFile,
        importedDocs,
        importedFiles,
        totalEntries: importedDocs + importedFiles,
      };
    } catch (err) {
      await saga.compensateAll();
      throw err;
    }
  }

  private async ensurePersonalSpace(
    spaceId: string,
    userId: string,
  ): Promise<void> {
    if (!isUuid(spaceId) || spaceId.toLowerCase() !== userId.toLowerCase()) {
      return;
    }
    await this.prisma.space
      .upsert({
        where: { id: spaceId },
        create: { id: spaceId, type: 'personal', ownerUserId: userId },
        update: {},
      })
      .catch(() => undefined);
  }
}
