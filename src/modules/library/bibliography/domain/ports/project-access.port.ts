export const PROJECT_ACCESS_PORT = Symbol('PROJECT_ACCESS_PORT');

export interface IProjectAccessPort {
  canAccessProject(userId: string, projectId: string): Promise<boolean>;
  isProjectOwner(userId: string, projectId: string): Promise<boolean>;
}
