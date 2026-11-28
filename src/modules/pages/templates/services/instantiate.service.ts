/**
 * templates/services/instantiate.service.ts
 * GoF Prototype Batch Instantiator (`instantiate`) aligned 1:1 with `duplicate.service.ts`:
 * - Executes a single atomic PostgreSQL `$transaction` (`tx.page.create`, `tx.pageDoc.createMany`,
 *   `tx.pageFile.createMany`, depth-ordered `tx.pageNode.createMany`).
 * - Zero-copy `FileBlob` reference acquisition (`filesPort.acquireBlob`).
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import { FILES_PORT } from '@/modules/files/files.constant';
import { type IFilesPort } from '@/modules/files/types/files.type';
import { InstantiateTemplateDto } from '../dto/template.dto';
import { GalleryService } from './gallery.service';

export interface InstantiateResult {
  readonly pageId: string;
  readonly spaceId: string;
  readonly isPersonal: boolean;
  readonly rootDocId: string;
  readonly title: string;
  readonly compiler: string;
  readonly texlive: string;
  readonly mainFile: string;
  readonly createdDocs: number;
  readonly createdFiles: number;
}

@Injectable()
export class InstantiateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gallery: GalleryService,
    @Optional()
    @Inject(FILES_PORT)
    private readonly filesPort?: IFilesPort,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  public async instantiate(
    spaceId: string,
    templateKey: string,
    userId: string,
    dto?: InstantiateTemplateDto,
  ): Promise<InstantiateResult> {
    const manifest = await this.gallery.getAuthorizedManifest(
      templateKey,
      userId,
      spaceId,
    );
    const isPersonal =
      isUuid(spaceId) && spaceId.toLowerCase() === userId.toLowerCase();

    const plan = manifest.buildPageClonePlan({
      spaceId,
      customTitle: dto?.title,
    });

    await this.prisma.$transaction(async (tx) => {
      if (isPersonal && tx.space?.upsert) {
        await tx.space.upsert({
          where: { id: spaceId },
          create: { id: spaceId, type: 'personal', ownerUserId: userId },
          update: {},
        });
      }

      await tx.page.create({
        data: {
          id: plan.pageId,
          spaceId,
          rootDocId: null,
          title: plan.title,
          description: manifest.description,
          status: 'draft',
          compiler: plan.compiler,
          texlive: plan.texlive,
          spellLang: 'en_US',
          createdById: isUuid(userId) ? userId : null,
          settings: {
            fromTemplateId: plan.templateId,
          } as Prisma.InputJsonValue,
        },
      });

      if (plan.docsToCreate.length > 0) {
        await tx.pageDoc.createMany({ data: plan.docsToCreate });
      }

      await tx.page.update({
        where: { id: plan.pageId },
        data: { rootDocId: plan.rootDocId },
      });

      if (plan.filesToCreate.length > 0) {
        await tx.pageFile.createMany({ data: plan.filesToCreate });
      }

      const sortedDepths = Array.from(plan.nodeBatchesByDepth.keys()).sort(
        (a, b) => a - b,
      );
      for (const depth of sortedDepths) {
        const batch = plan.nodeBatchesByDepth.get(depth);
        if (batch && batch.length > 0) {
          await tx.pageNode.createMany({ data: batch });
        }
      }
    });

    if (this.filesPort && plan.blobIncrements.size > 0) {
      const acquireTasks: Array<Promise<unknown>> = [];
      for (const [blobId, count] of plan.blobIncrements.entries()) {
        for (let i = 0; i < count; i++) {
          acquireTasks.push(
            Promise.resolve(this.filesPort.acquireBlob(blobId)).catch(
              () => null,
            ),
          );
        }
      }
      await Promise.all(acquireTasks);
    }

    this.eventEmitter?.emit('pages.file-tree.change', {
      projectId: spaceId,
      change: {
        action: 'page_created_from_template',
        pageId: plan.pageId,
        templateId: manifest.id,
      },
    });

    return {
      pageId: plan.pageId,
      spaceId,
      isPersonal,
      rootDocId: plan.rootDocId,
      title: plan.title,
      compiler: plan.compiler,
      texlive: plan.texlive,
      mainFile: plan.mainFile,
      createdDocs: plan.docsToCreate.length,
      createdFiles: plan.filesToCreate.length,
    };
  }
}
