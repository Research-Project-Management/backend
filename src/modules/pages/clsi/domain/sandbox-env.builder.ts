/**
 * modules/manuscripts/clsi/domain/sandbox-env.builder.ts
 * Pure function building an allow-listed environment for sandbox executions.
 * Purges all sensitive host environment variables (DATABASE_URL, JWT_SECRET, etc.)
 * and injects paranoid TeX I/O flags.
 */

export interface SandboxEnvOptions {
  parentEnv?: Record<string, string | undefined>;
  extraEnv?: Record<string, string | undefined>;
  clientAllowList?: string[];
  platform?: NodeJS.Platform;
  isTexProcess?: boolean;
}

const BASE_ALLOW_LIST = ['PATH', 'LANG', 'LC_ALL', 'TZ'];
const WINDOWS_ALLOW_LIST = ['SystemRoot', 'TEMP', 'TMP'];
const PIPELINE_TEX_ALLOW_LIST = [
  'TEXINPUTS',
  'BIBINPUTS',
  'BSTINPUTS',
  'HOME',
  'TEXMFVAR',
  'TEXMFCACHE',
];

export function buildSandboxEnv(
  options: SandboxEnvOptions = {},
): Record<string, string> {
  const {
    parentEnv = {},
    extraEnv = {},
    clientAllowList = [],
    platform = process.platform,
    isTexProcess = true,
  } = options;

  const result: Record<string, string> = {};

  // 1. Forward base allow-listed variables from parentEnv
  for (const key of BASE_ALLOW_LIST) {
    const val = parentEnv[key];
    if (val !== undefined) {
      result[key] = val;
    }
  }

  // 2. Forward Windows-specific allow-listed variables if running on Windows
  if (platform === 'win32') {
    for (const key of WINDOWS_ALLOW_LIST) {
      const val = parentEnv[key];
      if (val !== undefined) {
        result[key] = val;
      }
    }
  }

  // 3. Forward client-specific allow-listed variables from parentEnv (e.g. DOCKER_HOST)
  for (const key of clientAllowList) {
    const val = parentEnv[key];
    if (val !== undefined) {
      result[key] = val;
    }
  }

  // 4. Merge allowed pipeline variables from extraEnv
  for (const [key, val] of Object.entries(extraEnv)) {
    if (
      val !== undefined &&
      (PIPELINE_TEX_ALLOW_LIST.includes(key) || clientAllowList.includes(key))
    ) {
      result[key] = val;
    }
  }

  // 5. Injected paranoid TeX I/O restrictions for TeX compilation processes
  if (isTexProcess) {
    result.openin_any = 'p';
    result.openout_any = 'p';
    result.shell_escape = 'f';
  }

  return result;
}
