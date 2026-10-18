/**
 * Shared Origin Validation Predicate
 * Used by both HTTP CORS configuration and WebSocket gateway/adapter.
 */

export interface OriginConfigOptions {
  clientUrl?: string;
  extraOrigins?: string[];
  allowVercelPreview?: boolean;
  nodeEnv?: string;
}

const DEFAULT_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:5173',
  'http://localhost:2915',
  'http://localhost:2916',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:2915',
];

const LOCAL_LAN_REGEX =
  /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/;

const VERCEL_REGEX =
  /^https:\/\/[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.vercel\.app$/;

/**
 * Checks whether a given request origin is permitted under platform CORS/WebSocket security rules.
 *
 * Rules:
 * - Empty/undefined/null origin: Allowed (non-browser clients, cURL, server-to-server)
 * - Exact matches in allowlist (default local ports + CLIENT_URL + ORIGINS env)
 * - Any localhost / 127.0.0.1 / private LAN IP
 * - Vercel preview environments when enabled or in non-production environments
 */
export function isOriginAllowed(
  origin: string | undefined | null,
  options?: OriginConfigOptions,
): boolean {
  // Allow non-browser requests (Postman, curl, native tools, internal server calls)
  if (!origin || origin.trim() === '') {
    return true;
  }

  const normalizedOrigin = origin.trim().replace(/\/+$/, '');

  const clientUrl = options?.clientUrl ?? process.env.CLIENT_URL;
  const extraOrigins =
    options?.extraOrigins ??
    (process.env.ORIGINS
      ? process.env.ORIGINS.split(',').map((o) => o.trim())
      : []);
  const allowVercelPreview =
    options?.allowVercelPreview ?? (process.env.ALLOW_VERCEL_PREVIEW === 'true');
  const nodeEnv = options?.nodeEnv ?? process.env.NODE_ENV;

  const allowedSet = new Set<string>();
  for (const def of DEFAULT_ORIGINS) {
    allowedSet.add(def.replace(/\/+$/, ''));
  }
  if (clientUrl) {
    allowedSet.add(clientUrl.trim().replace(/\/+$/, ''));
  }
  for (const ext of extraOrigins) {
    if (ext) {
      allowedSet.add(ext.replace(/\/+$/, ''));
    }
  }

  // 1. Exact match with allowed list
  if (allowedSet.has(normalizedOrigin)) {
    return true;
  }

  // 2. Allow any localhost / 127.0.0.1 / private LAN IP origins
  if (LOCAL_LAN_REGEX.test(normalizedOrigin)) {
    return true;
  }

  // 3. Dynamic match for Vercel preview deployments (*.vercel.app)
  const isVercelConfigured =
    clientUrl?.includes('.vercel.app') ||
    allowVercelPreview ||
    nodeEnv !== 'production';

  if (isVercelConfigured && VERCEL_REGEX.test(normalizedOrigin)) {
    return true;
  }

  return false;
}
