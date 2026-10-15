/**
 * Universal Authenticated Request Contract
 *
 * Strongly-typed FastifyRequest contract including authenticated user payload
 * from JWT / session guards, eliminating raw any request parameters.
 */

import type { FastifyRequest } from 'fastify';

export interface AuthenticatedUserPayload {
  id?: string;
  sub?: string;
  userId?: string;
  email?: string;
  name?: string;
  avatar?: string | null;
  status?: string;
  role?: string;
  [key: string]: unknown;
}

export interface AuthenticatedRequest extends FastifyRequest {
  user?: AuthenticatedUserPayload | null;
  projectMember?: { role?: string; [key: string]: unknown };
}
