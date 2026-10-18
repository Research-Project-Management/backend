/**
 * modules/manuscripts/clsi/services/sandbox/sandbox-config.ts
 * Strongly typed configuration for CLSI compile sandbox isolation.
 * Enforces production fail-closed invariants and warns on legacy configuration options.
 */

import { Logger } from '@nestjs/common';
import * as os from 'os';
import * as path from 'path';
import { SandboxConfigurationException } from '../../domain/sandbox-errors';

export type SandboxMode = 'container' | 'local-unsafe';

export interface ClsiSandboxConfig {
  readonly mode: SandboxMode;
  readonly image: string;
  readonly user: string;
  readonly memoryMb: number;
  readonly cpus: number;
  readonly pidsLimit: number;
  readonly maxFileSizeMb: number;
  readonly maxOpenFiles: number;
  readonly tmpfsMb: number;
  readonly timeoutMs: number;
  readonly runtime?: string;
  readonly scratchDir: string;
  readonly isProduction: boolean;
  readonly clientEnvAllowList: readonly string[];
}

export interface ParseSandboxConfigOptions {
  env?: Record<string, string | undefined>;
  isProduction?: boolean;
}

const logger = new Logger('ClsiSandboxConfig');
const DIGEST_REGEX = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

export function parseSandboxConfig(
  options: ParseSandboxConfigOptions = {},
): ClsiSandboxConfig {
  const env = options.env ?? process.env;
  const isProduction =
    options.isProduction ??
    (env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production');

  // Mode resolution (with legacy fallback)
  let mode: SandboxMode;
  if (env.CLSI_SANDBOX_MODE) {
    const rawMode = env.CLSI_SANDBOX_MODE.toLowerCase();
    if (rawMode === 'container' || rawMode === 'local-unsafe') {
      mode = rawMode;
    } else {
      throw new SandboxConfigurationException(
        `Invalid CLSI_SANDBOX_MODE "${env.CLSI_SANDBOX_MODE}". Must be "container" or "local-unsafe".`,
      );
    }
  } else if (env.USE_DOCKER_SANDBOX !== undefined) {
    logger.warn(
      'USE_DOCKER_SANDBOX is deprecated; use CLSI_SANDBOX_MODE="container" | "local-unsafe" instead.',
    );
    mode = env.USE_DOCKER_SANDBOX === 'true' ? 'container' : 'local-unsafe';
  } else {
    // Default is container mode
    mode = 'container';
  }

  // Fail-closed in production
  if (isProduction && mode !== 'container') {
    throw new SandboxConfigurationException(
      'CLSI sandbox mode "local-unsafe" is strictly forbidden in production. Container sandbox is mandatory.',
    );
  }

  // Image resolution (with legacy fallback)
  let image = env.CLSI_SANDBOX_IMAGE;
  if (!image && env.DOCKER_IMAGE) {
    logger.warn('DOCKER_IMAGE is deprecated; use CLSI_SANDBOX_IMAGE instead.');
    image = env.DOCKER_IMAGE;
  }

  if (mode === 'container') {
    if (!image) {
      if (isProduction) {
        throw new SandboxConfigurationException(
          'CLSI_SANDBOX_IMAGE is required in production container mode.',
        );
      }
      image = 'sharelatex/clsi:latest';
    }

    if (isProduction && !DIGEST_REGEX.test(image)) {
      throw new SandboxConfigurationException(
        `In production, CLSI_SANDBOX_IMAGE must be pinned with @sha256:<64-hex-digest> (got: "${image}").`,
      );
    }
  } else {
    image = image || '';
  }

  // User resolution (UID:GID)
  const user = env.CLSI_SANDBOX_USER || '65534:65534';
  if (user === '0:0' || user.startsWith('0:') || user === 'root') {
    throw new SandboxConfigurationException(
      'CLSI sandbox container cannot run as root user.',
    );
  }

  // Resource limits
  const memoryMb = parseInt(env.CLSI_SANDBOX_MEMORY_MB || '1024', 10);
  const cpus = parseFloat(env.CLSI_SANDBOX_CPUS || '1.0');
  const pidsLimit = parseInt(env.CLSI_SANDBOX_PIDS || '100', 10);
  const maxFileSizeMb = parseInt(env.CLSI_SANDBOX_FSIZE_MB || '256', 10);
  const maxOpenFiles = parseInt(env.CLSI_SANDBOX_NOFILE || '1024', 10);
  const tmpfsMb = parseInt(env.CLSI_SANDBOX_TMPFS_MB || '256', 10);
  const timeoutMs = parseInt(env.CLSI_SANDBOX_TIMEOUT_MS || '240000', 10);

  if (memoryMb <= 0 || cpus <= 0 || pidsLimit <= 0 || timeoutMs <= 0) {
    throw new SandboxConfigurationException(
      'CLSI sandbox resource limits must be positive numbers.',
    );
  }

  const scratchDir =
    env.CLSI_SCRATCH_DIR ||
    env.SCRATCH_DIR ||
    path.join(os.tmpdir(), 'clsi-scratch');

  const clientEnvAllowList = Object.freeze([
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY',
  ]);

  return {
    mode,
    image,
    user,
    memoryMb,
    cpus,
    pidsLimit,
    maxFileSizeMb,
    maxOpenFiles,
    tmpfsMb,
    timeoutMs,
    runtime: env.CLSI_SANDBOX_RUNTIME || undefined,
    scratchDir,
    isProduction,
    clientEnvAllowList,
  };
}
