import { AuditOutcome, AuditSeverity } from '@prisma/client';

export { AuditOutcome, AuditSeverity };

/**
 * Standardized hierarchical audit actions (CADF / OWASP / GitHub naming standard):
 * Format: <category>.<operation>
 */
export const AUDIT_ACTIONS = {
  // Authentication & Identity
  AUTH_LOGIN_SUCCESS: 'auth.login_success',
  AUTH_LOGIN_FAILED: 'auth.login_failed',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_TOKEN_REFRESHED: 'auth.token_refreshed',
  AUTH_TOKEN_REVOKED: 'auth.token_revoked',
  AUTH_TOKEN_BREACH_DETECTED: 'auth.token_breach_detected',
  AUTH_PASSWORD_RESET_REQUESTED: 'auth.password_reset_requested',
  AUTH_PASSWORD_RESET_COMPLETED: 'auth.password_reset_completed',
  AUTH_OAUTH_ACCOUNT_LINKED: 'auth.oauth_account_linked',
  AUTH_OAUTH_ACCOUNT_UNLINKED: 'auth.oauth_account_unlinked',
  AUTH_EMAIL_VERIFICATION_REQUESTED: 'auth.email_verification_requested',
  AUTH_EMAIL_VERIFIED: 'auth.email_verified',
  AUTH_ACCOUNT_DEACTIVATED: 'auth.account_deactivated',

  // Project Governance & Sensitive Access Operations
  PROJECT_OWNERSHIP_TRANSFERRED: 'project.ownership_transferred',
  PROJECT_MEMBER_INVITED: 'project.member_invited',
  PROJECT_MEMBER_REMOVED: 'project.member_removed',
  PROJECT_MEMBER_ROLE_UPDATED: 'project.member_role_updated',
  PROJECT_MEMBER_PERMISSIONS_OVERRIDDEN:
    'project.member_permissions_overridden',
} as const;

export type AuditActionType =
  (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS] | (string & {});

/**
 * Enterprise Audit Event Input Contract (CADF 5W1H Standard).
 */
export interface AuditLogRecordInput {
  /** Who: Identifier of the authenticated user performing the action */
  actorId?: string | null;

  /** Who: Optional ID if an admin / support agent is acting on behalf of the user */
  impersonatorId?: string | null;

  /** What: Action identifier in <category>.<operation> notation */
  action: AuditActionType;

  /** Outcome of the action: success | failure | denied */
  outcome?: AuditOutcome;

  /** Severity for infrastructure log filtering: info | warning | error | critical */
  severity?: AuditSeverity;

  /** Scope: Project context ID (essential for project management systems) */
  projectId?: string | null;

  /** Target: Type of target resource (e.g. 'user', 'session', 'project', 'member') */
  targetType?: string | null;

  /** Target: Identifier of target resource */
  targetId?: string | null;

  /** Client IP address for brute-force tracking & anomaly detection */
  ipAddress?: string | null;

  /** Client User-Agent for device identification & bot detection */
  userAgent?: string | null;

  /** Observability: OpenTelemetry / W3C Trace ID */
  traceId?: string | null;

  /** Contextual state diff or payload metadata */
  metadata?: Record<string, unknown> | null;
}

/** Backward-compatibility alias */
export type SecurityAuditEvent = AuditLogRecordInput;
export type SecurityAuditLogEntry = AuditLogRecordInput;
