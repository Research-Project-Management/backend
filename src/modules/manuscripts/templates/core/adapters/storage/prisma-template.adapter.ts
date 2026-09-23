import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  ITemplateRepositoryPort,
  FindTemplatesFilter,
  SearchTemplatesFilter,
  FindTemplatesResult,
} from '../../ports/template-repository.port';
import { ManuscriptTemplateEntity } from '../../domain/entities/manuscript-template.entity';
import { InMemoryTemplateAdapter } from './in-memory-template.adapter';
import { TemplateCategoryString } from '../../domain/value-objects/template-category.vo';
import { CompilerType } from '../../domain/value-objects/compiler-type.vo';

@Injectable()
export class PrismaTemplateAdapter implements ITemplateRepositoryPort {
  private readonly logger = new Logger(PrismaTemplateAdapter.name);
  private readonly memoryFallback = new InMemoryTemplateAdapter();

  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<ManuscriptTemplateEntity | null> {
    try {
      const record = await (this.prisma as any).manuscriptTemplate.findUnique({
        where: { id },
      });
      if (record) {
        return this.mapToEntity(record);
      }
      return this.memoryFallback.findById(id);
    } catch {
      return this.memoryFallback.findById(id);
    }
  }

  async findByVersionId(versionId: string): Promise<ManuscriptTemplateEntity | null> {
    try {
      const record = await (this.prisma as any).manuscriptTemplate.findUnique({
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
    try {
      const where: any = {};
      if (filter?.category && filter.category !== 'all') {
        where.category = filter.category;
      }
      if (filter?.isOfficial !== undefined) {
        where.isOfficial = filter.isOfficial;
      }
      if (filter?.tag) {
        where.tags = { has: filter.tag };
      }

      const total = await (this.prisma as any).manuscriptTemplate.count({ where });
      if (total === 0) {
        // If DB table is empty or unpopulated, fallback to in-memory official templates
        return this.memoryFallback.findAll(filter);
      }

      const records = await (this.prisma as any).manuscriptTemplate.findMany({
        where,
        orderBy: [{ isOfficial: 'desc' }, { downloadCount: 'desc' }],
        skip: filter?.offset ?? 0,
        take: filter?.limit ?? 50,
      });

      return {
        templates: records.map((r: any) => this.mapToEntity(r)),
        total,
      };
    } catch {
      return this.memoryFallback.findAll(filter);
    }
  }

  async search(filter: SearchTemplatesFilter): Promise<FindTemplatesResult> {
    try {
      const q = filter.query.trim();
      const where: any = {};
      if (filter.category && filter.category !== 'all') {
        where.category = filter.category;
      }
      if (q) {
        where.OR = [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
          { author: { contains: q, mode: 'insensitive' } },
          { tags: { has: q.toLowerCase() } },
        ];
      }

      const total = await (this.prisma as any).manuscriptTemplate.count({ where });
      if (total === 0) {
        return this.memoryFallback.search(filter);
      }

      const records = await (this.prisma as any).manuscriptTemplate.findMany({
        where,
        orderBy: { downloadCount: 'desc' },
        skip: filter.offset ?? 0,
        take: filter.limit ?? 50,
      });

      return {
        templates: records.map((r: any) => this.mapToEntity(r)),
        total,
      };
    } catch {
      return this.memoryFallback.search(filter);
    }
  }

  async save(template: ManuscriptTemplateEntity): Promise<ManuscriptTemplateEntity> {
    try {
      const data = {
        id: template.id,
        versionId: template.versionId,
        name: template.name,
        category: template.category as any,
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

      const record = await (this.prisma as any).manuscriptTemplate.upsert({
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
    try {
      const result = await (this.prisma as any).manuscriptTemplate.deleteMany({
        where: { id },
      });
      this.memoryFallback.delete(id);
      return result.count > 0;
    } catch {
      return this.memoryFallback.delete(id);
    }
  }

  async incrementDownloadCount(id: string): Promise<void> {
    try {
      await (this.prisma as any).manuscriptTemplate.update({
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

  private mapToEntity(record: any): ManuscriptTemplateEntity {
    return new ManuscriptTemplateEntity({
      id: record.id,
      versionId: record.versionId,
      name: record.name,
      category: record.category as TemplateCategoryString,
      description: record.description,
      compiler: record.compiler as CompilerType,
      imageName: record.imageName,
      mainFile: record.mainFile,
      thumbnailUrl: record.thumbnailUrl,
      author: record.author,
      tags: Array.isArray(record.tags) ? record.tags : [],
      isOfficial: record.isOfficial,
      downloadCount: record.downloadCount,
      files: typeof record.files === 'object' && record.files !== null ? record.files : {},
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    });
  }
}
