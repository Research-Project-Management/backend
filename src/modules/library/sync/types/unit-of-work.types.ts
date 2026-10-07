export const UNIT_OF_WORK_PORT = Symbol('UNIT_OF_WORK_PORT');

export interface IUnitOfWork {
  executeInTransaction<T>(
    operation: (context: unknown) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
}
