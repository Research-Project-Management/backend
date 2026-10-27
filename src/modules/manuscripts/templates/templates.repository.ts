/**
 * templates/templates.repository.ts
 * Direct @Injectable() Repository for Manuscripts Templates.
 *
 * Encapsulates the real seam between PostgreSQL (Prisma) and the in-memory
 * OfficialTemplateCatalog stand-in, as well as Prisma project instantiation.
 */

import {
  Injectable,
  Logger,
  Optional,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import {
  Prisma,
  ManuscriptTemplateCategory,
  ManuscriptTemplate,
} from '@prisma/client';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { SagaRunner } from '@/modules/manuscripts/core/utils/saga-runner';
import {
  ITemplateRepositoryPort,
  FindTemplatesFilter,
  SearchTemplatesFilter,
  FindTemplatesResult,
  IProjectInstantiatorPort,
  InstantiateProjectInput,
  InstantiatedProjectResult,
  ManuscriptTemplateEntity,
  TemplateCategoryString,
  TemplateCategoryVo,
  CompilerType,
  OFFICIAL_TEMPLATE_CATALOG,
} from './domain';

@Injectable()
export class TemplatesRepository
  implements ITemplateRepositoryPort, IProjectInstantiatorPort
{
  private readonly logger = new Logger(TemplatesRepository.name);
  private readonly officialCatalog = new Map<
    string,
    ManuscriptTemplateEntity
  >();
  private readonly aliasIndex = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly structureService?: StructureService,
    @Optional()
    private readonly docstoreService?: DocstoreService,
  ) {
    this.seedOfficialCatalog();
  }

  private seedOfficialCatalog(): void {
    for (const d of OFFICIAL_TEMPLATE_CATALOG) {
      const entity = ManuscriptTemplateEntity.create({
        id: d.id,
        versionId: d.versionId,
        name: d.name,
        category: d.category,
        description: d.description,
        compiler: d.compiler,
        imageName: d.imageName,
        mainFile: d.mainFile,
        author: d.author,
        tags: [...d.tags],
        isOfficial: d.isOfficial,
        downloadCount: d.downloadCount,
        files: { ...d.files },
      });
      this.officialCatalog.set(entity.id, entity);
      this.aliasIndex.set(entity.id.toLowerCase(), entity.id);
      this.aliasIndex.set(entity.versionId.toLowerCase(), entity.id);
      this.aliasIndex.set(d.slug.toLowerCase(), entity.id);
      for (const alias of d.aliases) {
        this.aliasIndex.set(alias.toLowerCase(), entity.id);
      }
    }
  }

  private resolveOfficialCatalogTemplate(
    idOrAlias: string,
  ): ManuscriptTemplateEntity | null {
    if (!idOrAlias) return null;
    const direct = this.officialCatalog.get(idOrAlias);
    if (direct) return direct;
    const resolvedId =
      this.aliasIndex.get(idOrAlias) ??
      this.aliasIndex.get(idOrAlias.toLowerCase().trim());
    return resolvedId ? this.officialCatalog.get(resolvedId) || null : null;
  }

  async findById(id: string): Promise<ManuscriptTemplateEntity | null> {
    if (!id) return null;
    if (this.prisma) {
      if (isUuid(id)) {
        const record = await this.prisma.manuscriptTemplate.findUnique({
          where: { id },
        });
        if (record) {
          return this.mapToEntity(record);
        }
      } else {
        const recordByVersion = await this.prisma.manuscriptTemplate.findUnique(
          {
            where: { versionId: id },
          },
        );
        if (recordByVersion) {
          return this.mapToEntity(recordByVersion);
        }
      }
    }
    return this.resolveOfficialCatalogTemplate(id);
  }

  async findByVersionId(
    versionId: string,
  ): Promise<ManuscriptTemplateEntity | null> {
    if (!versionId) return null;
    if (this.prisma) {
      const record = await this.prisma.manuscriptTemplate.findUnique({
        where: { versionId },
      });
      if (record) {
        return this.mapToEntity(record);
      }
    }
    return this.resolveOfficialCatalogTemplate(versionId);
  }

  async findAll(filter?: FindTemplatesFilter): Promise<FindTemplatesResult> {
    const where: Prisma.ManuscriptTemplateWhereInput = {};
    if (
      filter?.category &&
      filter.category !== 'all' &&
      TemplateCategoryVo.isValid(filter.category)
    ) {
      where.category = this.toPrismaCategory(filter.category);
    }
    if (filter?.isOfficial !== undefined) {
      where.isOfficial = filter.isOfficial;
    }
    if (filter?.tag) {
      where.tags = { has: filter.tag };
    }

    const [total, records] = await Promise.all([
      this.prisma.manuscriptTemplate.count({ where }),
      this.prisma.manuscriptTemplate.findMany({
        where,
        orderBy: [{ isOfficial: 'desc' }, { downloadCount: 'desc' }],
        skip: filter?.offset ?? 0,
        take: filter?.limit ?? 50,
      }),
    ]);

    const matchingOfficial = Array.from(this.officialCatalog.values()).filter(
      (t) => {
        if (
          filter?.category &&
          filter.category !== 'all' &&
          t.category !== filter.category
        ) {
          return false;
        }
        if (
          filter?.isOfficial !== undefined &&
          t.isOfficial !== filter.isOfficial
        ) {
          return false;
        }
        if (filter?.tag && !t.tags.includes(filter.tag)) {
          return false;
        }
        return true;
      },
    );

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 50;

    if (total === 0) {
      return {
        templates: matchingOfficial.slice(offset, offset + limit),
        total: matchingOfficial.length,
      };
    }

    const dbEntities = records.map((r: ManuscriptTemplate) =>
      this.mapToEntity(r),
    );
    const dbIdsAndSlugs = new Set<string>();
    for (const e of dbEntities) {
      dbIdsAndSlugs.add(e.id.toLowerCase());
      dbIdsAndSlugs.add(e.versionId.toLowerCase());
    }
    const nonDuplicateOfficial = matchingOfficial.filter((t) => {
      const def = OFFICIAL_TEMPLATE_CATALOG.find((d) => d.id === t.id);
      return (
        !dbIdsAndSlugs.has(t.id.toLowerCase()) &&
        !dbIdsAndSlugs.has(t.versionId.toLowerCase()) &&
        !(def && dbIdsAndSlugs.has(def.slug.toLowerCase()))
      );
    });
    const remaining = Math.max(0, limit - dbEntities.length);
    const officialOffset = Math.max(0, offset - total);
    const slicedOfficial =
      remaining > 0
        ? nonDuplicateOfficial.slice(officialOffset, officialOffset + remaining)
        : [];
    const merged = [...dbEntities, ...slicedOfficial];

    return {
      templates: merged,
      total: total + nonDuplicateOfficial.length,
    };
  }

  async search(filter: SearchTemplatesFilter): Promise<FindTemplatesResult> {
    const q = filter.query.trim();
    const where: Prisma.ManuscriptTemplateWhereInput = {};
    if (
      filter.category &&
      filter.category !== 'all' &&
      TemplateCategoryVo.isValid(filter.category)
    ) {
      where.category = this.toPrismaCategory(filter.category);
    }
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { author: { contains: q, mode: 'insensitive' } },
        { tags: { has: q.toLowerCase() } },
      ];
    }

    const [total, records] = await Promise.all([
      this.prisma.manuscriptTemplate.count({ where }),
      this.prisma.manuscriptTemplate.findMany({
        where,
        orderBy: { downloadCount: 'desc' },
        skip: filter.offset ?? 0,
        take: filter.limit ?? 50,
      }),
    ]);

    const qLower = q.toLowerCase();
    const matchingOfficial = Array.from(this.officialCatalog.values()).filter(
      (t) => {
        if (
          filter.category &&
          filter.category !== 'all' &&
          t.category !== filter.category
        ) {
          return false;
        }
        if (!qLower) return true;
        return (
          t.name.toLowerCase().includes(qLower) ||
          (t.description ?? '').toLowerCase().includes(qLower) ||
          t.author.toLowerCase().includes(qLower) ||
          t.tags.some((tag) => tag.toLowerCase().includes(qLower))
        );
      },
    );

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;

    if (total === 0) {
      return {
        templates: matchingOfficial.slice(offset, offset + limit),
        total: matchingOfficial.length,
      };
    }

    const dbEntities = records.map((r: ManuscriptTemplate) =>
      this.mapToEntity(r),
    );
    const dbIdsAndSlugs = new Set<string>();
    for (const e of dbEntities) {
      dbIdsAndSlugs.add(e.id.toLowerCase());
      dbIdsAndSlugs.add(e.versionId.toLowerCase());
    }
    const nonDuplicateOfficial = matchingOfficial.filter((t) => {
      const def = OFFICIAL_TEMPLATE_CATALOG.find((d) => d.id === t.id);
      return (
        !dbIdsAndSlugs.has(t.id.toLowerCase()) &&
        !dbIdsAndSlugs.has(t.versionId.toLowerCase()) &&
        !(def && dbIdsAndSlugs.has(def.slug.toLowerCase()))
      );
    });
    const remaining = Math.max(0, limit - dbEntities.length);
    const officialOffset = Math.max(0, offset - total);
    const slicedOfficial =
      remaining > 0
        ? nonDuplicateOfficial.slice(officialOffset, officialOffset + remaining)
        : [];
    const merged = [...dbEntities, ...slicedOfficial];

    return {
      templates: merged,
      total: total + nonDuplicateOfficial.length,
    };
  }

  async save(
    template: ManuscriptTemplateEntity,
  ): Promise<ManuscriptTemplateEntity> {
    const data: Prisma.ManuscriptTemplateCreateInput = {
      id: template.id,
      versionId: template.versionId,
      name: template.name,
      category: this.toPrismaCategory(template.category),
      description: template.description,
      compiler: template.compiler,
      imageName: template.imageName,
      mainFile: template.mainFile,
      thumbnailUrl: template.thumbnailUrl,
      author: template.author,
      tags: template.tags,
      isOfficial: template.isOfficial,
      downloadCount: template.downloadCount,
      files: template.files,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    };

    const record = await this.prisma.manuscriptTemplate.upsert({
      where: { id: template.id },
      create: data,
      update: data,
    });

    return this.mapToEntity(record);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.prisma.manuscriptTemplate.deleteMany({
      where: { id },
    });
    return result.count > 0;
  }

  async incrementDownloadCount(id: string): Promise<void> {
    await this.prisma.manuscriptTemplate.updateMany({
      where: { id },
      data: {
        downloadCount: { increment: 1 },
      },
    });
  }

  async instantiate(
    input: InstantiateProjectInput,
  ): Promise<InstantiatedProjectResult> {
    const { template, projectName, userId } = input;
    const generatedProjectId = crypto.randomUUID();
    const cleanName = projectName.trim() || template.name;
    const baseSlug =
      cleanName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 30) || 'manuscript';
    const identifier = `${baseSlug}-${generatedProjectId.slice(0, 6)}`;

    const fileEntries = Object.entries(template.files);
    const filePaths = Object.keys(template.files);

    let finalProjectId: string = generatedProjectId;

    try {
      const createProjectAndOwner = async (
        tx: Prisma.TransactionClient | PrismaService,
      ) => {
        const project = await tx.project.create({
          data: {
            id: generatedProjectId,
            name: cleanName,
            identifier,
            description: `Created from template: ${template.name}`,
            createdById: userId,
            modules: ['overview', 'work-items', 'pages'],
            settings: {
              manuscript: {
                compiler: template.compiler,
                mainFile: template.mainFile,
                imageName: template.imageName,
                fromTemplateId: template.id,
                fromTemplateVersionId: template.versionId,
              },
            },
          },
        });

        const projectId = project?.id || generatedProjectId;
        await tx.projectMember.create({
          data: {
            projectId,
            userId,
            role: 'owner',
          },
        });
        return projectId;
      };

      finalProjectId = await this.prisma.$transaction(async (tx) =>
        createProjectAndOwner(tx),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Prisma project creation failed: ${msg}`);
      throw new InternalServerErrorException(
        `Failed to create project from template: ${msg}`,
      );
    }

    if (this.structureService && this.docstoreService) {
      const structureService = this.structureService;
      const docstoreService = this.docstoreService;
      const saga = new SagaRunner({
        logger: this.logger,
        contextName: `TemplatesRepository.createProjectFromTemplate(${finalProjectId})`,
      });

      // Register compensation for the Prisma project if subsequent file hydration fails critically
      await saga.step(
        'EnsureProjectCompensation',
        async () => finalProjectId,
        async (pid) => {
          if (typeof this.prisma?.project?.delete === 'function') {
            await this.prisma.project
              .delete({ where: { id: pid } })
              .catch(() => undefined);
          }
        },
      );

      try {
        for (const [filePath, content] of fileEntries) {
          const normalizedPath = filePath.startsWith('/')
            ? filePath
            : `/${filePath}`;
          const parts = normalizedPath.split('/').filter(Boolean);
          const fileName = parts.pop() || filePath;
          let parentFolderId: string | undefined = undefined;

          if (parts.length > 0) {
            const dirPath = `/${parts.join('/')}`;
            const dirNode = await structureService.mkdirp(
              finalProjectId,
              dirPath,
            );
            parentFolderId = dirNode.id;
          }

          const isRootDoc =
            normalizedPath === `/${template.mainFile.replace(/^\//, '')}`;

          const createdDoc = await saga.step(
            `CreateDoc(${normalizedPath})`,
            async () =>
              docstoreService.createDoc(finalProjectId, {
                path: normalizedPath,
                lines: content.split('\n'),
                version: 1,
              }),
            async (doc) => {
              if (doc?._id && typeof docstoreService.deleteDoc === 'function') {
                await docstoreService.deleteDoc(finalProjectId, doc._id);
              }
            },
          );

          await saga.step(
            `CreateNode(${normalizedPath})`,
            async () =>
              structureService.createNode(finalProjectId, {
                name: fileName,
                path: normalizedPath,
                type: 'DOC',
                parentId: parentFolderId,
                docId: createdDoc._id,
                isRootDoc,
              }),
            async (node) => {
              if (node?.id && typeof structureService.deleteNode === 'function') {
                await structureService.deleteNode(finalProjectId, node.id);
              }
            },
          );
        }
      } catch (err: unknown) {
        await saga.compensateAll();
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Template hydration failed for project ${finalProjectId}; rolled back via Saga: ${msg}`,
        );
        throw new InternalServerErrorException(
          `Failed to hydrate template files for project: ${msg}`,
        );
      }
    }

    return {
      projectId: finalProjectId,
      projectName: cleanName,
      ownerId: userId,
      compiler: template.compiler,
      mainFile: template.mainFile,
      fileCount: filePaths.length,
      files: filePaths,
      fromTemplateId: template.id,
      fromTemplateVersionId: template.versionId,
      createdAt: new Date(),
    };
  }

  private mapToEntity(record: ManuscriptTemplate): ManuscriptTemplateEntity {
    return new ManuscriptTemplateEntity({
      id: record.id,
      versionId: record.versionId,
      name: record.name,
      category: record.category,
      description: record.description,
      compiler: record.compiler as CompilerType,
      imageName: record.imageName,
      mainFile: record.mainFile,
      thumbnailUrl: record.thumbnailUrl,
      author: record.author,
      tags: Array.isArray(record.tags) ? record.tags : [],
      isOfficial: record.isOfficial,
      downloadCount: record.downloadCount,
      files:
        typeof record.files === 'object' && record.files !== null
          ? (record.files as Record<string, string>)
          : {},
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    });
  }

  private toPrismaCategory(
    category: TemplateCategoryString,
  ): ManuscriptTemplateCategory {
    switch (category) {
      case 'journal':
      case 'conference':
      case 'thesis':
      case 'cv':
      case 'presentation':
      case 'report':
        return category;
      default:
        return ManuscriptTemplateCategory.other;
    }
  }
}
