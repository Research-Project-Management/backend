import { ManuscriptTemplateEntity } from '../domain/entities/manuscript-template.entity';

export interface FindTemplatesFilter {
  category?: string;
  isOfficial?: boolean;
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface SearchTemplatesFilter {
  query: string;
  category?: string;
  limit?: number;
  offset?: number;
}

export interface FindTemplatesResult {
  templates: ManuscriptTemplateEntity[];
  total: number;
}

export const TEMPLATE_REPOSITORY_PORT = Symbol('TEMPLATE_REPOSITORY_PORT');

export interface ITemplateRepositoryPort {
  findById(id: string): Promise<ManuscriptTemplateEntity | null>;
  findByVersionId(versionId: string): Promise<ManuscriptTemplateEntity | null>;
  findAll(filter?: FindTemplatesFilter): Promise<FindTemplatesResult>;
  search(filter: SearchTemplatesFilter): Promise<FindTemplatesResult>;
  save(template: ManuscriptTemplateEntity): Promise<ManuscriptTemplateEntity>;
  delete(id: string): Promise<boolean>;
  incrementDownloadCount(id: string): Promise<void>;
}
