/**
 * Role Definitions & Hierarchy
 * Evaluated at the Project level across 4 canonical roles:
 * - OWNER: Project Leader / PI (full administrative and member management authority)
 * - COORDINATOR: Project Coordinator (work management, cycles, triage, task assignment)
 * - CONTRIBUTOR: Research Member (work items, documents, literature, file uploads)
 * - REVIEWER: Advisor / Peer Reviewer (read-only with comments and suggestions)
 */
export enum Role {
  OWNER = 'owner',
  COORDINATOR = 'coordinator',
  CONTRIBUTOR = 'contributor',
  REVIEWER = 'reviewer',
}

export const RoleHierarchy: Record<Role, number> = {
  [Role.OWNER]: 40,
  [Role.COORDINATOR]: 30,
  [Role.CONTRIBUTOR]: 20,
  [Role.REVIEWER]: 10,
};

// ─── Human-readable Role Descriptions ─────────────────────────────────────────
export const ROLE_DESCRIPTIONS: Record<
  Role,
  { label: string; description: string }
> = {
  [Role.OWNER]: {
    label: 'Project Owner',
    description:
      'Full project management, settings configuration, member administration, and project deletion.',
  },
  [Role.COORDINATOR]: {
    label: 'Project Coordinator',
    description:
      'Manage timeline, cycle planning, task assignments, and work items oversight. No member management rights.',
  },
  [Role.CONTRIBUTOR]: {
    label: 'Contributor',
    description:
      'Create and edit work items, author manuscripts/LaTeX, and upload research reference materials.',
  },
  [Role.REVIEWER]: {
    label: 'Reviewer',
    description:
      'View project data, write feedback, notes, and suggestions without direct mutation of baseline documents.',
  },
};

export const ProjectRole = Role;
export type ProjectRole = Role;
export const ProjectRoleHierarchy = RoleHierarchy;
