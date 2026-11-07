import { ManuscriptTemplateEntity } from './template.entity';

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

export interface InstantiateProjectInput {
  template: ManuscriptTemplateEntity;
  projectName: string;
  userId: string;
}

export interface InstantiatedProjectResult {
  projectId: string;
  projectName: string;
  ownerId: string;
  compiler: string;
  mainFile: string;
  fileCount: number;
  files: string[];
  fromTemplateId: string;
  fromTemplateVersionId: string;
  createdAt: Date;
}

export const PROJECT_INSTANTIATOR_PORT = Symbol('PROJECT_INSTANTIATOR_PORT');

export interface IProjectInstantiatorPort {
  instantiate(
    input: InstantiateProjectInput,
  ): Promise<InstantiatedProjectResult>;
}
