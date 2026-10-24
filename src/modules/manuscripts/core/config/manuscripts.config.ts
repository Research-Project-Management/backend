/**
 * modules/manuscripts/core/config/manuscripts.config.ts
 * Centralized environment variable configuration for Manuscripts module (SC-001).
 * All process.env access within src/modules/manuscripts MUST go through this file.
 */

import * as os from 'os';
import * as path from 'path';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService, registerAs } from '@nestjs/config';

export interface ManuscriptsEnvConfig {
  readonly nodeEnv: string;
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly gitBridge: {
    readonly root: string;
    readonly gitBinary: string;
    readonly authorName: string;
    readonly authorEmail: string;
    readonly publicUrl?: string;
    readonly safeParentEnv: Record<string, string>;
  };
  readonly sandbox: {
    readonly rawEnv: Record<string, string | undefined>;
    readonly safeHostEnv: Record<string, string | undefined>;
  };
}

const SAFE_HOST_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
] as const;

export function getSafeHostEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of SAFE_HOST_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}

export function getRawManuscriptsEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

export function readManuscriptsConfig(): ManuscriptsEnvConfig {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  return {
    nodeEnv,
    isProduction,
    isTest,
    gitBridge: {
      root:
        process.env.GIT_BRIDGE_ROOT ||
        path.join(os.tmpdir(), 'flux-git-bridge'),
      gitBinary: process.env.GIT_BINARY || 'git',
      authorName: process.env.GIT_BRIDGE_AUTHOR_NAME || 'Flux',
      authorEmail:
        process.env.GIT_BRIDGE_AUTHOR_EMAIL || 'git-bridge@flux.local',
      publicUrl:
        process.env.GIT_BRIDGE_PUBLIC_URL ||
        process.env.PUBLIC_API_URL ||
        undefined,
      safeParentEnv: getSafeHostEnv(),
    },
    sandbox: {
      rawEnv: getRawManuscriptsEnv(),
      safeHostEnv: getSafeHostEnv(),
    },
  };
}

export const manuscriptsConfig = registerAs(
  'manuscripts',
  (): ManuscriptsEnvConfig => readManuscriptsConfig(),
);

@Injectable()
export class ManuscriptsConfigService {
  constructor(@Optional() private readonly configService?: ConfigService) {}

  public getConfig(): ManuscriptsEnvConfig {
    return (
      this.configService?.get<ManuscriptsEnvConfig>('manuscripts') ??
      readManuscriptsConfig()
    );
  }
}
