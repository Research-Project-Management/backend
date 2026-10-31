/**
 * modules/manuscripts/clsi/services/sandbox/sandbox-config.ts
 * Strongly typed configuration for CLSI compile sandbox isolation.
 * Enforces production fail-closed invariants.
 */

import * as os from 'os';
import * as path from 'path';
import { SandboxConfigurationException } from '../../domain/sandbox.errors';
import {
  DEFAULT_SANDBOX_PROFILE,
  SandboxProfile,
} from '../../domain/sandbox-profile';
import {
  getRawManuscriptsEnv,
  readManuscriptsConfig,
} from '../../../core/config/manuscripts.config';

export type SandboxMode = 'container' | 'local-unsafe' | 'remote';

export interface ClsiSandboxConfig {
  readonly mode: SandboxMode;
  readonly remoteUrl?: string;
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

const DIGEST_REGEX = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

export function parseSandboxConfig(
  options: ParseSandboxConfigOptions = {},
): ClsiSandboxConfig {
  const defaultConfig = readManuscriptsConfig();
  const env = options.env ?? getRawManuscriptsEnv();
  const isProduction =
    options.isProduction ??
    (env.NODE_ENV === 'production' || defaultConfig.isProduction);

  const remoteUrl = (env.CLSI_URL || '').trim() || undefined;

  // Mode resolution
  let mode: SandboxMode;
  if (env.CLSI_SANDBOX_MODE) {
    const rawMode = env.CLSI_SANDBOX_MODE.toLowerCase();
    if (rawMode === 'container') {
      mode = 'container';
    } else if (rawMode === 'local-unsafe' || rawMode === 'local') {
      mode = 'local-unsafe';
    } else if (rawMode === 'remote') {
      mode = 'remote';
    } else {
      throw new SandboxConfigurationException(
        `Invalid CLSI_SANDBOX_MODE "${env.CLSI_SANDBOX_MODE}". Must be "container", "local-unsafe", or "remote".`,
      );
    }
  } else if (remoteUrl && !env.CLSI_SANDBOX_IMAGE) {
    // Self-hosted multi-tier mode: when CLSI_URL points to a dedicated CLSI container
    mode = 'remote';
  } else {
    // Default is container mode
    mode = 'container';
  }

  // Fail-closed in production: local-unsafe is forbidden unless explicitly delegating to remote CLSI container
  if (isProduction && mode === 'local-unsafe') {
    throw new SandboxConfigurationException(
      'CLSI sandbox mode "local-unsafe" is strictly forbidden in production. Container or remote CLSI sandbox is mandatory.',
    );
  }

  // Image resolution
  let image = env.CLSI_SANDBOX_IMAGE;

  if (mode === 'container') {
    if (!image) {
      if (isProduction && !remoteUrl) {
        throw new SandboxConfigurationException(
          'CLSI_SANDBOX_IMAGE is required in production container mode.',
        );
      }
      image = 'sharelatex/clsi:latest';
    }

    if (isProduction && !remoteUrl && !DIGEST_REGEX.test(image)) {
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
    remoteUrl,
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

export function buildSandboxProfileFromConfig(
  config: ClsiSandboxConfig,
): SandboxProfile {
  return Object.freeze({
    ...DEFAULT_SANDBOX_PROFILE,
    user: config.user,
    tmpfs: Object.freeze({
      mountPath: '/tmp',
      options: `rw,noexec,nosuid,size=${config.tmpfsMb}m`,
      sizeMb: config.tmpfsMb,
    }),
    memoryBytes: config.memoryMb * 1024 * 1024,
    cpus: config.cpus,
    pidsLimit: config.pidsLimit,
    maxFileSizeBytes: config.maxFileSizeMb * 1024 * 1024,
    maxOpenFiles: config.maxOpenFiles,
    wallClockMs: config.timeoutMs,
    runtime: config.runtime,
  });
}
