/**
 * IAM Domain Types & Branded Identifiers
 * Follows Matt Pocock's Total TypeScript principles for zero-cost type branding.
 */

// ─── 1. Branded Identifiers ──────────────────────────────────────────────────

export type UserId = string & { readonly __brand: unique symbol };
export type WorkspaceId = string & { readonly __brand: unique symbol };
export type ProjectId = string & { readonly __brand: unique symbol };

export const toUserId = (id: string): UserId => id as UserId;
export const toWorkspaceId = (id: string): WorkspaceId => id as WorkspaceId;
export const toProjectId = (id: string): ProjectId => id as ProjectId;

// ─── 2. Authenticated Context & Payload ──────────────────────────────────────

export interface AuthenticatedUser {
  readonly id: UserId;
  readonly email: string;
  readonly name: string;
  readonly avatar: string | null;
  readonly isVerified: boolean;
}

export interface JwtPayload {
  readonly sub: UserId;
  readonly email: string;
  readonly iat?: number;
  readonly exp?: number;
}

export interface AuthSessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}
