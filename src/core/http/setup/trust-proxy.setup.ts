/**
 * core/http/setup/trust-proxy.setup.ts
 * Shared Fastify trustProxy resolver for main.ts and realtime.ts.
 */

export type TrustProxyConfig =
  boolean | string | ((address: string, hop: number) => boolean);

export function resolveTrustProxyConfig(): TrustProxyConfig {
  const maxProxyHops = process.env.TRUST_PROXY_HOPS
    ? parseInt(process.env.TRUST_PROXY_HOPS, 10)
    : 1;

  if (process.env.TRUST_PROXY === 'false') {
    return false;
  }
  if (process.env.TRUST_PROXY && process.env.TRUST_PROXY !== 'true') {
    return process.env.TRUST_PROXY;
  }
  return (_address: string, hop: number) => hop <= maxProxyHops;
}
