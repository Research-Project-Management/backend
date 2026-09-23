/**
 * modules/manuscripts/structure/core/domain/structure-errors.ts
 * Domain errors for Project File Tree & Structure.
 */

export class StructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NodeNotFoundError extends StructureError {
  constructor(identifier: string) {
    super(`Manuscript node not found: ${identifier}`);
  }
}

export class DuplicateNodePathError extends StructureError {
  constructor(path: string) {
    super(`A node already exists at path: ${path}`);
  }
}

export class CyclicMoveError extends StructureError {
  constructor(sourcePath: string, destPath: string) {
    super(`Cannot move directory '${sourcePath}' into its own descendant '${destPath}'`);
  }
}

export class InvalidNodeNameError extends StructureError {
  constructor(name: string, reason?: string) {
    super(`Invalid node name '${name}'${reason ? `: ${reason}` : ''}`);
  }
}

export class CannotDeleteRootFolderError extends StructureError {
  constructor() {
    super('The root directory cannot be deleted.');
  }
}

export class RootDocNotFoundError extends StructureError {
  constructor(projectId: string) {
    super(`No valid root document (main.tex) could be resolved for project ${projectId}`);
  }
}
