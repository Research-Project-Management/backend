import { Role } from '@prisma/client';

/**
 * Checks if a project member role has ownership privileges.
 */
export function isOwner(role: Role): boolean {
  return role === Role.owner;
}

/**
 * Checks if a project member role is capable of execution / work-item assignment (owner or contributor).
 */
export function isExecutionRole(role: Role): boolean {
  return (
    role === Role.owner ||
    role === Role.coordinator ||
    role === Role.contributor
  );
}

/**
 * Checks whether an owner can be demoted or removed given the current owner count in the project.
 * Enforces the Single-Owner Invariant (there must always be at least one owner).
 */
export function canDemoteOrRemoveOwner(ownerCount: number): boolean {
  return ownerCount > 1;
}
