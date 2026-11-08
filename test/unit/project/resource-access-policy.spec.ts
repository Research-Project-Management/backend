import { ForbiddenException } from '@nestjs/common';
import {
  ResourceAccessPolicy,
  PolicySubject,
} from '@/modules/project/access/policies/resource-access.policy';
import { Role } from '@/modules/project/access/enums/role.enum';

describe('ResourceAccessPolicy (Dynamic ABAC & Resource Ownership Engine)', () => {
  let policy: ResourceAccessPolicy;

  const authorId = 'user-author-uuid';
  const reviewerId = 'user-reviewer-uuid';
  const ownerId = 'user-owner-uuid';
  const coordinatorId = 'user-coordinator-uuid';
  const peerId = 'user-peer-uuid';

  const authorSubject: PolicySubject = {
    userId: authorId,
    role: Role.CONTRIBUTOR,
  };

  const peerSubject: PolicySubject = {
    userId: peerId,
    role: Role.CONTRIBUTOR,
  };

  const ownerSubject: PolicySubject = {
    userId: ownerId,
    role: Role.OWNER,
  };

  const coordinatorSubject: PolicySubject = {
    userId: coordinatorId,
    role: Role.COORDINATOR,
  };

  const reviewerSubject: PolicySubject = {
    userId: reviewerId,
    role: Role.REVIEWER,
  };

  beforeEach(() => {
    policy = new ResourceAccessPolicy();
  });

  describe('Comment & Peer Review Academic Integrity', () => {
    const comment = {
      id: 'comment-uuid-1',
      authorId: authorId,
    };

    it('should permit author to update their own comment', () => {
      expect(() =>
        policy.assertCanModifyComment(authorSubject, comment, 'update'),
      ).not.toThrow();
    });

    it('should reject peer contributor attempting to update another author comment', () => {
      expect(() =>
        policy.assertCanModifyComment(peerSubject, comment, 'update'),
      ).toThrow(ForbiddenException);
    });

    it('should REJECT Project Owner attempting to update someone else review (Tamper Prevention)', () => {
      // Academic integrity invariant: Even PI / Project Owner cannot rewrite someone else's written review
      expect(() =>
        policy.assertCanModifyComment(ownerSubject, comment, 'update'),
      ).toThrow(ForbiddenException);
    });

    it('should permit author to delete their own comment', () => {
      expect(() =>
        policy.assertCanModifyComment(authorSubject, comment, 'delete'),
      ).not.toThrow();
    });

    it('should permit Project Owner to delete any comment for moderation', () => {
      expect(() =>
        policy.assertCanModifyComment(ownerSubject, comment, 'delete'),
      ).not.toThrow();
    });

    it('should reject peer contributor attempting to delete another author comment', () => {
      expect(() =>
        policy.assertCanModifyComment(peerSubject, comment, 'delete'),
      ).toThrow(ForbiddenException);
    });
  });

  describe('Work Item Ownership & Lifecycle Governance', () => {
    const workItem = {
      id: 'wi-uuid-100',
      createdById: authorId,
      isLocked: false,
    };

    const lockedWorkItem = {
      id: 'wi-uuid-200',
      createdById: authorId,
      isLocked: true,
    };

    it('should permit Creator Contributor to delete their own work item', () => {
      expect(() =>
        policy.assertCanModifyWorkItem(authorSubject, workItem, 'delete'),
      ).not.toThrow();
    });

    it('should reject Peer Contributor attempting to delete a work item they did not create', () => {
      expect(() =>
        policy.assertCanModifyWorkItem(peerSubject, workItem, 'delete'),
      ).toThrow(ForbiddenException);
    });

    it('should permit Coordinator and Owner to delete any work item in project', () => {
      expect(() =>
        policy.assertCanModifyWorkItem(coordinatorSubject, workItem, 'delete'),
      ).not.toThrow();
      expect(() =>
        policy.assertCanModifyWorkItem(ownerSubject, workItem, 'delete'),
      ).not.toThrow();
    });

    it('should reject Reviewer from modifying work items under any circumstances', () => {
      expect(() =>
        policy.assertCanModifyWorkItem(reviewerSubject, workItem, 'delete'),
      ).toThrow(ForbiddenException);
      expect(() =>
        policy.assertCanModifyWorkItem(reviewerSubject, workItem, 'update'),
      ).toThrow(ForbiddenException);
    });

    it('should reject Contributor from updating a locked work item', () => {
      expect(() =>
        policy.assertCanModifyWorkItem(authorSubject, lockedWorkItem, 'update'),
      ).toThrow(ForbiddenException);
    });

    it('should permit Coordinator and Owner to update locked work items', () => {
      expect(() =>
        policy.assertCanModifyWorkItem(
          coordinatorSubject,
          lockedWorkItem,
          'update',
        ),
      ).not.toThrow();
      expect(() =>
        policy.assertCanModifyWorkItem(ownerSubject, lockedWorkItem, 'update'),
      ).not.toThrow();
    });
  });

  describe('Manuscript & Document Freeze Protection', () => {
    const activeDoc = {
      id: 'doc-draft-uuid',
      authorId: authorId,
      isLocked: false,
      status: 'draft',
    };

    const publishedDoc = {
      id: 'doc-published-uuid',
      authorId: authorId,
      isLocked: true,
      status: 'published',
    };

    it('should permit author to delete active draft manuscript', () => {
      expect(() =>
        policy.assertCanModifyDocument(authorSubject, activeDoc, 'delete'),
      ).not.toThrow();
    });

    it('should reject peer contributor from deleting someone else manuscript', () => {
      expect(() =>
        policy.assertCanModifyDocument(peerSubject, activeDoc, 'delete'),
      ).toThrow(ForbiddenException);
    });

    it('should reject author from deleting a published / camera-ready frozen manuscript', () => {
      expect(() =>
        policy.assertCanModifyDocument(authorSubject, publishedDoc, 'delete'),
      ).toThrow(ForbiddenException);
    });

    it('should permit Owner to delete published manuscript with administrative authority', () => {
      expect(() =>
        policy.assertCanModifyDocument(ownerSubject, publishedDoc, 'delete'),
      ).not.toThrow();
    });
  });
});
