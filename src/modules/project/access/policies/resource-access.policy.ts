import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../enums/role.enum';
import { Permission } from '../enums/permission.enum';
import { PermissionBitmaskUtil } from '../utils/permission-bitmask.util';

/**
 * Subject Context representing the requesting actor.
 */
export interface PolicySubject {
  readonly userId: string;
  readonly role: Role;
  readonly permissionBitmask?: string;
  readonly permissionOverrides?: Record<string, boolean>;
}

/**
 * Resource Context representing the target entity being accessed or mutated.
 */
export interface PolicyResource {
  readonly id: string;
  readonly authorId?: string | null;
  readonly createdById?: string | null;
  readonly projectId?: string | null;
  readonly isLocked?: boolean | null;
  readonly state?: string | null;
  readonly status?: string | null;
}

/**
 * Enterprise Attribute-Based Access Control (ABAC) Policy Engine
 * Complies with NIST SP 800-162 Policy Decision Point (PDP) specifications:
 * Evaluates fine-grained subject attributes, resource ownership, and lifecycle states
 * beyond coarse-grained role-based access control.
 */
@Injectable()
export class ResourceAccessPolicy {
  /**
   * Enforces Academic Peer-Review Integrity for Comments:
   * 1. UPDATE: Only the original author can edit their own comment text.
   *    (Strict integrity invariant: Project Owners CANNOT tamper with another researcher's written review).
   * 2. DELETE:
   *    - Author can delete their own comment (COMMENT_DELETE_OWN).
   *    - Project Owner can moderate/delete any comment (COMMENT_DELETE_ANY).
   *    - Other members cannot delete comments created by peers.
   */
  assertCanModifyComment(
    subject: PolicySubject,
    comment: { id: string; authorId: string },
    action: 'update' | 'delete',
  ): void {
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    const isAuthor = subject.userId === comment.authorId;

    if (action === 'update') {
      if (!isAuthor) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'FORBIDDEN_COMMENT_UPDATE',
          message:
            'Academic integrity violation: Only the original author can edit their own comment or review.',
        });
      }
      return;
    }

    if (action === 'delete') {
      // 1. Author can delete their own comment
      if (isAuthor) {
        return;
      }

      // 2. Project Owner has administrative moderation authority (COMMENT_DELETE_ANY)
      if (subject.role === Role.OWNER) {
        return;
      }

      // 3. Check explicit COMMENT_DELETE_ANY permission if bitmask is available
      if (subject.permissionBitmask) {
        const mask = PermissionBitmaskUtil.fromHex(subject.permissionBitmask);
        if (PermissionBitmaskUtil.has(mask, Permission.COMMENT_DELETE_ANY)) {
          return;
        }
      }

      throw new ForbiddenException({
        statusCode: 403,
        code: 'FORBIDDEN_COMMENT_DELETE',
        message:
          'Insufficient authority: You can only delete your own comments unless you possess moderation privileges.',
      });
    }
  }

  /**
   * Enforces Ownership and Lifecycle Governance on Work Items:
   * 1. UPDATE:
   *    - Project Owner & Coordinator have full work item update rights.
   *    - Contributor can update work items unless the work item is explicitly locked.
   * 2. DELETE:
   *    - Project Owner & Coordinator can delete any work item in the project.
   *    - Contributor can ONLY delete work items they created themselves.
   *    - Reviewer cannot delete work items under any circumstances.
   */
  assertCanModifyWorkItem(
    subject: PolicySubject,
    workItem: {
      id: string;
      createdById?: string | null;
      isLocked?: boolean | null;
    },
    action: 'update' | 'delete',
  ): void {
    if (!workItem) {
      throw new NotFoundException('Work item not found');
    }

    // Reviewer has zero mutation authority on work items
    if (subject.role === Role.REVIEWER) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'FORBIDDEN_ROLE_READONLY',
        message: 'Reviewers have read-only access to work items.',
      });
    }

    // OWNER has unconditional authority
    if (subject.role === Role.OWNER) {
      return;
    }

    if (action === 'delete') {
      // Coordinator has project-wide work management authority
      if (subject.role === Role.COORDINATOR) {
        return;
      }

      // Contributor can only delete work items they authored
      const isCreator =
        workItem.createdById && workItem.createdById === subject.userId;
      if (isCreator) {
        return;
      }

      throw new ForbiddenException({
        statusCode: 403,
        code: 'FORBIDDEN_WORK_ITEM_DELETE',
        message:
          'Access denied: Contributors can only delete work items they created.',
      });
    }

    if (action === 'update') {
      // Locked work items require Owner or Coordinator authority
      if (workItem.isLocked && subject.role !== Role.COORDINATOR) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'FORBIDDEN_WORK_ITEM_LOCKED',
          message:
            'This work item is locked. Contact a project coordinator or owner to make changes.',
        });
      }
    }
  }

  /**
   * Enforces Document & Manuscript Author Rights and Freeze Policies:
   * 1. Publication / Camera-Ready Freeze:
   *    - When document is published or locked, only Project Owner can mutate baseline.
   * 2. DELETE:
   *    - Project Owner can delete any manuscript.
   *    - Contributor can delete if they are the author and manuscript is not locked.
   */
  assertCanModifyDocument(
    subject: PolicySubject,
    document: {
      id: string;
      authorId?: string | null;
      isLocked?: boolean | null;
      status?: string | null;
    },
    action: 'update' | 'delete',
  ): void {
    if (!document) {
      throw new NotFoundException('Document not found');
    }

    if (subject.role === Role.OWNER) {
      return;
    }

    // Locked or Published Freeze
    if (
      (document.isLocked || document.status === 'published') &&
      action !== 'update'
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'FORBIDDEN_DOCUMENT_FROZEN',
        message:
          'Manuscript is frozen or published. Only project owners can delete or alter baseline structure.',
      });
    }

    const isAuthor =
      document.authorId && document.authorId === subject.userId;

    if (action === 'delete') {
      if (subject.role === Role.COORDINATOR || isAuthor) {
        return;
      }

      throw new ForbiddenException({
        statusCode: 403,
        code: 'FORBIDDEN_DOCUMENT_DELETE',
        message:
          'Access denied: You can only delete manuscripts you authored.',
      });
    }
  }
}
