import { Injectable } from '@nestjs/common';
import {
  ITemplateRepositoryPort,
  FindTemplatesFilter,
  SearchTemplatesFilter,
  FindTemplatesResult,
} from '@/modules/manuscripts/templates/core/ports/template-repository.port';
import { ManuscriptTemplateEntity } from '@/modules/manuscripts/templates/core/domain/entities/manuscript-template.entity';
import { OFFICIAL_TEMPLATE_CATALOG } from '@/modules/manuscripts/templates/core/domain/catalog/official-template-catalog';

@Injectable()
export class InMemoryTemplateAdapter implements ITemplateRepositoryPort {
  private readonly templates = new Map<string, ManuscriptTemplateEntity>();
  private readonly aliasIndex = new Map<string, string>(); // versionId / slug / alias -> canonical id

  constructor() {
    this.seedDefaults();
  }

  seedDefaults(): void {
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
      this.templates.set(entity.id, entity);
      this.aliasIndex.set(entity.id.toLowerCase(), entity.id);
      this.aliasIndex.set(entity.versionId.toLowerCase(), entity.id);
      this.aliasIndex.set(d.slug.toLowerCase(), entity.id);
      for (const alias of d.aliases) {
        this.aliasIndex.set(alias.toLowerCase(), entity.id);
      }
    }
  }

  async findById(id: string): Promise<ManuscriptTemplateEntity | null> {
    if (!id) return null;
    const direct = this.templates.get(id);
    if (direct) return direct;

    // Resolve via slug, versionId, or alias
    const resolvedId =
      this.aliasIndex.get(id) ?? this.aliasIndex.get(id.toLowerCase().trim());
    if (resolvedId) {
      return this.templates.get(resolvedId) || null;
    }
    return null;
  }

  async findByVersionId(
    versionId: string,
  ): Promise<ManuscriptTemplateEntity | null> {
    if (!versionId) return null;
    const id =
      this.aliasIndex.get(versionId) ??
      this.aliasIndex.get(versionId.toLowerCase().trim());
    if (!id) return null;
    return this.templates.get(id) || null;
  }

  async findAll(filter?: FindTemplatesFilter): Promise<FindTemplatesResult> {
    let list = Array.from(this.templates.values());

    if (filter?.category && filter.category !== 'all') {
      const cat = filter.category.toLowerCase().trim();
      list = list.filter((t) => t.category.toLowerCase() === cat);
    }

    if (filter?.isOfficial !== undefined) {
      list = list.filter((t) => t.isOfficial === filter.isOfficial);
    }

    if (filter?.tag) {
      const tagLower = filter.tag.toLowerCase().trim();
      list = list.filter((t) =>
        t.tags.some((tg) => tg.toLowerCase() === tagLower),
      );
    }

    // Sort by official first, then downloadCount descending
    list.sort((a, b) => {
      if (a.isOfficial && !b.isOfficial) return -1;
      if (!a.isOfficial && b.isOfficial) return 1;
      return b.downloadCount - a.downloadCount;
    });

    const total = list.length;
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 50;
    const paginated = list.slice(offset, offset + limit);

    return { templates: paginated, total };
  }

  async search(filter: SearchTemplatesFilter): Promise<FindTemplatesResult> {
    const q = filter.query.toLowerCase().trim();
    let list = Array.from(this.templates.values());

    if (filter.category && filter.category !== 'all') {
      const cat = filter.category.toLowerCase().trim();
      list = list.filter((t) => t.category.toLowerCase() === cat);
    }

    if (q) {
      list = list.filter((t) => {
        const matchName = t.name.toLowerCase().includes(q);
        const matchDesc = t.description?.toLowerCase().includes(q) ?? false;
        const matchAuthor = t.author.toLowerCase().includes(q);
        const matchTag = t.tags.some((tag) => tag.toLowerCase().includes(q));
        return matchName || matchDesc || matchAuthor || matchTag;
      });
    }

    list.sort((a, b) => b.downloadCount - a.downloadCount);

    const total = list.length;
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    const paginated = list.slice(offset, offset + limit);

    return { templates: paginated, total };
  }

  async save(
    template: ManuscriptTemplateEntity,
  ): Promise<ManuscriptTemplateEntity> {
    this.templates.set(template.id, template);
    this.aliasIndex.set(template.id.toLowerCase(), template.id);
    this.aliasIndex.set(template.versionId.toLowerCase(), template.id);
    return template;
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.findById(id);
    if (!existing) return false;
    this.aliasIndex.delete(existing.versionId.toLowerCase());
    this.aliasIndex.delete(existing.id.toLowerCase());
    return this.templates.delete(existing.id);
  }

  async incrementDownloadCount(id: string): Promise<void> {
    const existing = await this.findById(id);
    if (existing) {
      existing.incrementDownloadCount();
      await this.save(existing);
    }
  }
}
