// ─── 1. Branded Identifiers ──────────────────────────────────────────────────

export type UserId = string & { readonly __brand: unique symbol };
export type ProjectId = string & { readonly __brand: unique symbol };

export const toUserId = (id: string): UserId => id as UserId;
export const toProjectId = (id: string): ProjectId => id as ProjectId;

// ─── 2. Authenticated Context & Payload ──────────────────────────────────────

export interface AuthenticatedUser {
  readonly id: UserId;
  readonly email: string;
  readonly name: string;
  readonly avatar: string | null;
  readonly status: string;
}

export interface JwtPayload {
  readonly sub: UserId;
  readonly email: string;
  readonly iat?: number;
  readonly exp?: number;
}

// ─── 3. Identity Facade & Gateway Contracts ──────────────────────────────────

export interface IdentityUserSession {
  userId: string;
  email: string;
  name: string;
  avatar?: string | null;
  status: string;
  isVerified?: boolean;
}

export interface IdentityAuthResult {
  valid: boolean;
  user?: IdentityUserSession | null;
  error?: string;
}
