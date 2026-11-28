/**
 * modules/pages/structure/domain/structure.errors.ts
 * Domain errors for Page Virtual Tree & Structure.
 */

import { PagesDomainError } from '@/modules/pages/core/domain/errors';

export class StructureError extends PagesDomainError {
  constructor(message: string, httpStatus = 400, code = 'STRUCTURE_ERROR') {
    super(message, {
      code,
      statusCode: httpStatus,
    });
  }
}

export class NodeNotFoundError extends StructureError {
  constructor(identifier: string) {
    super(
      `Manuscript node not found: ${identifier}`,
      404,
      'STRUCTURE_NODE_NOT_FOUND',
    );
  }
}

export class DuplicateNodePathError extends StructureError {
  constructor(path: string) {
    super(
      `A node already exists at path: ${path}`,
      409,
      'STRUCTURE_DUPLICATE_NODE_PATH',
    );
  }
}

export class CyclicMoveError extends StructureError {
  constructor(sourcePath: string, destPath: string) {
    super(
      `Cannot move directory '${sourcePath}' into its own descendant '${destPath}'`,
      400,
      'STRUCTURE_CYCLIC_MOVE',
    );
  }
}

export class InvalidNodeNameError extends StructureError {
  constructor(name: string, reason?: string) {
    super(
      `Invalid node name '${name}'${reason ? `: ${reason}` : ''}`,
      400,
      'STRUCTURE_INVALID_NODE_NAME',
    );
  }
}

export class CannotDeleteRootFolderError extends StructureError {
  constructor() {
    super(
      'The root directory cannot be deleted.',
      400,
      'STRUCTURE_CANNOT_DELETE_ROOT',
    );
  }
}

export class RootDocNotFoundError extends StructureError {
  constructor(projectId: string) {
    super(
      `No valid root document (main.tex) could be resolved for project ${projectId}`,
      404,
      'STRUCTURE_ROOT_DOC_NOT_FOUND',
    );
  }
}

export class MaxProjectFilesExceededError extends StructureError {
  constructor(limit = 2000) {
    super(
      `Project file limit of ${limit.toLocaleString()} files exceeded. Please remove unused files.`,
      400,
      'STRUCTURE_MAX_PROJECT_FILES_EXCEEDED',
    );
  }
}
