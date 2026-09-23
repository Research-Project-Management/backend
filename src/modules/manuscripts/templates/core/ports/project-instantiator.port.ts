import { ManuscriptTemplateEntity } from '../domain/entities/manuscript-template.entity';

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
  instantiate(input: InstantiateProjectInput): Promise<InstantiatedProjectResult>;
}
