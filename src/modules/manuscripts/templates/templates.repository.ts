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
  Inject,
  forwardRef,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '@/core';
import {
  Prisma,
  ManuscriptTemplateCategory,
  ManuscriptTemplate,
} from '@prisma/client';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import {
  ITemplateRepositoryPort,
  FindTemplatesFilter,
  SearchTemplatesFilter,
  FindTemplatesResult,
} from './core/ports/template-repository.port';
import {
  IProjectInstantiatorPort,
  InstantiateProjectInput,
  InstantiatedProjectResult,
} from './core/ports/project-instantiator.port';
import { ManuscriptTemplateEntity } from './core/domain/entities/manuscript-template.entity';
import { TemplateCategoryString } from './core/domain/value-objects/template-category.vo';
import { CompilerType } from './core/domain/value-objects/compiler-type.vo';
import { InMemoryTemplateAdapter } from './core/adapters/storage/in-memory-template.adapter';

const isUuid = (val?: string | null): val is string =>
  typeof val === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

@Injectable()
export class TemplatesRepository
  implements ITemplateRepositoryPort, IProjectInstantiatorPort
{
  private readonly logger = new Logger(TemplatesRepository.name);

  constructor(
    @Optional()
    private readonly prisma?: PrismaService,
    @Optional()
    private readonly memoryFallback: InMemoryTemplateAdapter = new InMemoryTemplateAdapter(),
    @Optional()
    @Inject(forwardRef(() => StructureService))
    private readonly structureService?: StructureService,
    @Optional()
    @Inject(forwardRef(() => DocstoreService))
    private readonly docstoreService?: DocstoreService,
  ) {}

  async findById(id: string): Promise<ManuscriptTemplateEntity | null> {
    if (!this.prisma) {
      return this.memoryFallback.findById(id);
    }
    try {
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
      return this.memoryFallback.findById(id);
    } catch {
      return this.memoryFallback.findById(id);
    }
  }

  async findByVersionId(
    versionId: string,
  ): Promise<ManuscriptTemplateEntity | null> {
    if (!this.prisma) {
      return this.memoryFallback.findByVersionId(versionId);
    }
    try {
      const record = await this.prisma.manuscriptTemplate.findUnique({
        where: { versionId },
      });
      if (record) {
        return this.mapToEntity(record);
      }
      return this.memoryFallback.findByVersionId(versionId);
    } catch {
      return this.memoryFallback.findByVersionId(versionId);
    }
  }

  async findAll(filter?: FindTemplatesFilter): Promise<FindTemplatesResult> {
    if (!this.prisma) {
      return this.memoryFallback.findAll(filter);
    }
    try {
      const where: Prisma.ManuscriptTemplateWhereInput = {};
      if (filter?.category && filter.category !== 'all') {
        where.category = filter.category as ManuscriptTemplateCategory;
      }
      if (filter?.isOfficial !== undefined) {
        where.isOfficial = filter.isOfficial;
      }
      if (filter?.tag) {
        where.tags = { has: filter.tag };
      }

      const total = await this.prisma.manuscriptTemplate.count({ where });
      if (total === 0) {
        return this.memoryFallback.findAll(filter);
      }

      const records = await this.prisma.manuscriptTemplate.findMany({
        where,
        orderBy: [{ isOfficial: 'desc' }, { downloadCount: 'desc' }],
        skip: filter?.offset ?? 0,
        take: filter?.limit ?? 50,
      });

      return {
        templates: records.map((r: ManuscriptTemplate) => this.mapToEntity(r)),
        total,
      };
    } catch {
      return this.memoryFallback.findAll(filter);
    }
  }

  async search(filter: SearchTemplatesFilter): Promise<FindTemplatesResult> {
    if (!this.prisma) {
      return this.memoryFallback.search(filter);
    }
    try {
      const q = filter.query.trim();
      const where: Prisma.ManuscriptTemplateWhereInput = {};
      if (filter.category && filter.category !== 'all') {
        where.category = filter.category as ManuscriptTemplateCategory;
      }
      if (q) {
        where.OR = [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
          { author: { contains: q, mode: 'insensitive' } },
          { tags: { has: q.toLowerCase() } },
        ];
      }

      const total = await this.prisma.manuscriptTemplate.count({ where });
      if (total === 0) {
        return this.memoryFallback.search(filter);
      }

      const records = await this.prisma.manuscriptTemplate.findMany({
        where,
        orderBy: { downloadCount: 'desc' },
        skip: filter.offset ?? 0,
        take: filter.limit ?? 50,
      });

      return {
        templates: records.map((r: ManuscriptTemplate) => this.mapToEntity(r)),
        total,
      };
    } catch {
      return this.memoryFallback.search(filter);
    }
  }

  async save(
    template: ManuscriptTemplateEntity,
  ): Promise<ManuscriptTemplateEntity> {
    if (!this.prisma) {
      return this.memoryFallback.save(template);
    }
    try {
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
    } catch {
      return this.memoryFallback.save(template);
    }
  }

  async delete(id: string): Promise<boolean> {
    if (!this.prisma) {
      return this.memoryFallback.delete(id);
    }
    try {
      const result = await this.prisma.manuscriptTemplate.deleteMany({
        where: { id },
      });
      await this.memoryFallback.delete(id);
      return result.count > 0;
    } catch {
      return this.memoryFallback.delete(id);
    }
  }

  async incrementDownloadCount(id: string): Promise<void> {
    if (!this.prisma) {
      await this.memoryFallback.incrementDownloadCount(id);
      return;
    }
    try {
      await this.prisma.manuscriptTemplate.update({
        where: { id },
        data: {
          downloadCount: { increment: 1 },
        },
      });
      await this.memoryFallback.incrementDownloadCount(id);
    } catch {
      await this.memoryFallback.incrementDownloadCount(id);
    }
  }

  /**
   * Instantiates a new project in Prisma and hydrates initial Structure + Docstore files.
   */
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

    if (this.prisma) {
      try {
        const project = await this.prisma.project.create({
          data: {
            id: generatedProjectId,
            name: cleanName,
            identifier,
            description: `Created from template: ${template.name}`,
            createdById: userId,
            modules: [
              'overview',
              'work_items',
              'cycles',
              'views',
              'pages',
              'manuscript',
            ],
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

        if (project?.id) {
          finalProjectId = project.id;
          await this.prisma.projectMember
            .create({
              data: {
                projectId: finalProjectId,
                userId,
                role: 'owner',
              },
            })
            .catch(() => {});
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Prisma project creation failed: ${msg}`);
        throw new InternalServerErrorException(
          `Failed to create project from template: ${msg}`,
        );
      }
    }

    if (this.structureService && this.docstoreService) {
      for (const [filePath, content] of fileEntries) {
        try {
          const parts = filePath.split('/');
          const fileName = parts.pop() || filePath;
          let parentFolderId: string | undefined = undefined;

          if (parts.length > 0) {
            const dirPath = parts.join('/');
            const dirNode = await this.structureService.mkdirp(
              finalProjectId,
              dirPath,
            );
            parentFolderId = dirNode.id;
          }

          const isRootDoc =
            filePath === template.mainFile ||
            `/${filePath.replace(/^\//, '')}` ===
              `/${template.mainFile.replace(/^\//, '')}`;

          const createdDoc = await this.docstoreService.createDoc(
            finalProjectId,
            {
              path: filePath.startsWith('/') ? filePath : `/${filePath}`,
              lines: content.split('\n'),
              version: 1,
            },
          );

          await this.structureService.createNode(finalProjectId, {
            name: fileName,
            type: 'DOC',
            parentId: parentFolderId,
            docId: createdDoc._id,
            isRootDoc,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.debug(`Could not write node/doc for ${filePath}: ${msg}`);
        }
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
