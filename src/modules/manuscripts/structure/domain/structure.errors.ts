/**
 * modules/manuscripts/structure/core/domain/structure.errors.ts
 * Domain errors for Project File Tree & Structure.
 */

export class StructureError extends Error {
  public readonly httpStatus: number;

  constructor(message: string, httpStatus = 400) {
    super(message);
    this.name = this.constructor.name;
    this.httpStatus = httpStatus;
  }
}

export class NodeNotFoundError extends StructureError {
  constructor(identifier: string) {
    super(`Manuscript node not found: ${identifier}`, 404);
  }
}

export class DuplicateNodePathError extends StructureError {
  constructor(path: string) {
    super(`A node already exists at path: ${path}`, 409);
  }
}

export class CyclicMoveError extends StructureError {
  constructor(sourcePath: string, destPath: string) {
    super(
      `Cannot move directory '${sourcePath}' into its own descendant '${destPath}'`,
      400,
    );
  }
}

export class InvalidNodeNameError extends StructureError {
  constructor(name: string, reason?: string) {
    super(`Invalid node name '${name}'${reason ? `: ${reason}` : ''}`, 400);
  }
}

export class CannotDeleteRootFolderError extends StructureError {
  constructor() {
    super('The root directory cannot be deleted.', 400);
  }
}

export class RootDocNotFoundError extends StructureError {
  constructor(projectId: string) {
    super(
      `No valid root document (main.tex) could be resolved for project ${projectId}`,
      404,
    );
  }
}

export class MaxProjectFilesExceededError extends StructureError {
  constructor(limit = 2000) {
    super(
      `Project file limit of ${limit.toLocaleString()} files exceeded. Please remove unused files.`,
      400,
    );
  }
}
