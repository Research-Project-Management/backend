import { Role } from '@prisma/client';
import { ProjectPermissions } from '../types/project.type';

/**
 * Authoritatively calculates granular project capabilities based on the actor's role
 * and current lifecycle state of the project.
 *
 * Enforces Zero-Trust: Frontend must never calculate permissions; Backend is the SSOT.
 */
export function calculateProjectPermissions(
  role?: Role | null,
  isActive = true,
): ProjectPermissions {
  const isOwner = role === Role.owner;

  if (!isActive) {
    // In archived/inactive state, project settings are read-only.
    // Only an owner has the authority to permanently delete or restore from archive.
    return {
      canEdit: false,
      canDelete: isOwner,
      canArchive: false,
      canManageMembers: false,
      canLeave: true,
    };
  }

  return {
    canEdit: isOwner,
    canDelete: isOwner,
    canArchive: isOwner,
    canManageMembers: isOwner,
    canLeave: true,
  };
}
