/**
 * Project Archive Pure Domain Logic
 *
 * Stateless domain validation, permission enrichment, and entity mapping
 * for project archiving and project-scoped archived items (work items & pages).
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { calculateProjectPermissions } from '../../core/utils/permission.util';
import {
  ArchivedPageSummary,
  ArchivedWorkItemSummary,
  EnrichedProject,
  ProjectLookupSummary,
  ProjectWithMembers,
} from '../types/archive.types';

/**
 * Validates that a project exists and can transition to the requested archive state.
 */
export function assertProjectArchiveTransition(
  project: ProjectLookupSummary | null,
  projectId: string,
  targetArchived: boolean,
): asserts project is ProjectLookupSummary {
  if (!project) {
    throw new NotFoundException(`Project with ID "${projectId}" not found`);
  }
  if (targetArchived && project.isArchived) {
    throw new BadRequestException('Project is already archived');
  }
  if (!targetArchived && !project.isArchived) {
    throw new BadRequestException('Project is not archived');
  }
}

/**
 * Enriches archived projects with the actor's role, calculated permissions, and flat label list.
 */
export function enrichArchivedProjectsForUser(
  projects: ProjectWithMembers[],
  userId: string,
  membershipMap: Map<string, Role>,
): EnrichedProject[] {
  return projects.map((p) => {
    const yourRole =
      p.createdById === userId
        ? Role.owner
        : membershipMap.get(p.id) ||
          p.members?.find((m) => m.userId === userId)?.role ||
          Role.reviewer;
    const permissions = calculateProjectPermissions(yourRole, p.isActive);

    return {
      ...p,
      yourRole,
      permissions,
      projectLabelsList: p.labels?.map((l) => l.label) || [],
    };
  });
}

/**
 * Normalizes raw Prisma work item records into ArchivedWorkItemSummary.
 */
export function mapArchivedWorkItemSummary(raw: {
  id: string;
  identifier: string | null;
  title: string;
  priority: string | null;
  stateId: string | null;
  completed: boolean;
  archivedAt: Date | null;
  updatedAt: Date;
  projectId: string;
  state?: { group: string } | null;
  assignee?: {
    id: string;
    email: string | null;
    profile?: { name: string | null; avatar: string | null } | null;
  } | null;
}): ArchivedWorkItemSummary {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    priority: raw.priority,
    stateId: raw.stateId,
    stateGroup: raw.state?.group ?? null,
    completed: Boolean(raw.completed),
    archivedAt: raw.archivedAt ? raw.archivedAt.toISOString() : null,
    updatedAt: raw.updatedAt.toISOString(),
    projectId: raw.projectId,
    assignee: raw.assignee
      ? {
          id: raw.assignee.id,
          email: raw.assignee.email,
          name: raw.assignee.profile?.name ?? null,
          avatar: raw.assignee.profile?.avatar ?? null,
        }
      : null,
  };
}

/**
 * Extracts archived root pages from PageNode + PageDoc records and applies optional search filter.
 */
export function extractArchivedPagesFromNodes(
  projectId: string,
  nodes: Array<{
    id: string;
    name: string;
    path: string;
    docId: string | null;
    createdAt: Date;
    updatedAt: Date;
    doc: {
      id: string;
      path: string;
      ranges: unknown;
      version: number;
      rev: number;
      createdAt: Date;
      updatedAt: Date;
    } | null;
  }>,
  search?: string,
): ArchivedPageSummary[] {
  const query = search?.trim().toLowerCase();
  const result: ArchivedPageSummary[] = [];

  for (const node of nodes) {
    const doc = node.doc;
    if (!doc) continue;

    const ranges =
      doc.ranges && typeof doc.ranges === 'object'
        ? (doc.ranges as Record<string, unknown>)
        : {};
    const status =
      typeof ranges.status === 'string' ? ranges.status : 'published';
    if (status !== 'archived') continue;

    const title =
      typeof ranges.title === 'string' && ranges.title.trim()
        ? ranges.title.trim()
        : node.name || doc.path.replace(/^\//, '') || 'Untitled Page';
    const description =
      typeof ranges.description === 'string' ? ranges.description : '';

    if (
      query &&
      !title.toLowerCase().includes(query) &&
      !description.toLowerCase().includes(query)
    ) {
      continue;
    }

    result.push({
      id: doc.id,
      title,
      description,
      status: 'archived',
      path: node.path || doc.path,
      projectId,
      version: doc.version ?? 1,
      rev: doc.rev ?? 1,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    });
  }

  return result;
}
