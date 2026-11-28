/**
 * modules/pages/clsi/domain/sandbox.policy.ts
 * Security profile defining container sandbox resource limits and isolation parameters.
 * Normative defaults reflect Overleaf/Flux zero-trust compile requirements.
 */

export interface SandboxProfile {
  /** Non-root UID:GID (e.g. '65534:65534' for nobody:nogroup) */
  readonly user: string;
  /** Whether the container root filesystem is mounted read-only */
  readonly readOnlyRootfs: boolean;
  /** Tmpfs configuration for ephemeral writable areas */
  readonly tmpfs: {
    readonly mountPath: string;
    readonly options: string;
    readonly sizeMb: number;
  };
  /** Container networking mode - strictly 'none' in production */
  readonly network: 'none' | 'host' | 'bridge';
  /** Linux capabilities to drop - defaults to ALL */
  readonly capabilities: readonly string[];
  /** Prevent acquiring additional privileges via setuid/setgid */
  readonly noNewPrivileges: boolean;
  /** Maximum memory limit in bytes (memory-swap must equal memory) */
  readonly memoryBytes: number;
  /** CPU quota allocated to the sandbox container */
  readonly cpus: number;
  /** Process limit to prevent fork bombs */
  readonly pidsLimit: number;
  /** Maximum file size in bytes (ulimit fsize) */
  readonly maxFileSizeBytes: number;
  /** Maximum open file descriptors (ulimit nofile) */
  readonly maxOpenFiles: number;
  /** Maximum wall-clock execution time in milliseconds */
  readonly wallClockMs: number;
  /** Optional OCI runtime (e.g. 'runsc' for gVisor) */
  readonly runtime?: string;
}

export const DEFAULT_SANDBOX_PROFILE: Readonly<SandboxProfile> = Object.freeze({
  user: '65534:65534',
  readOnlyRootfs: true,
  tmpfs: Object.freeze({
    mountPath: '/tmp',
    options: 'rw,noexec,nosuid,size=256m',
    sizeMb: 256,
  }),
  network: 'none',
  capabilities: Object.freeze(['ALL']),
  noNewPrivileges: true,
  memoryBytes: 1024 * 1024 * 1024, // 1 GiB
  cpus: 1.0,
  pidsLimit: 100,
  maxFileSizeBytes: 256 * 1024 * 1024, // 256 MiB
  maxOpenFiles: 1024,
  wallClockMs: 240000, // 4 minutes
});

export const DOCKER_CLIENT_ENV_ALLOW_LIST = Object.freeze([
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
]);

export interface SandboxEnvOptions {
  parentEnv?: Record<string, string | undefined>;
  extraEnv?: Record<string, string | undefined>;
  clientAllowList?: readonly string[];
  platform?: NodeJS.Platform;
  isTexProcess?: boolean;
  openinAny?: 'p' | 'r';
}

const BASE_ALLOW_LIST = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'HOME',
  'TMPDIR',
  'TEXMFVAR',
  'TEXMFCACHE',
  'XDG_CACHE_HOME',
];
const WINDOWS_ALLOW_LIST = ['SystemRoot', 'TEMP', 'TMP'];
const PIPELINE_TEX_ALLOW_LIST = [
  'TEXINPUTS',
  'BIBINPUTS',
  'BSTINPUTS',
  'HOME',
  'TEXMFVAR',
  'TEXMFCACHE',
  'XDG_CACHE_HOME',
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
    result.openin_any = options.openinAny === 'r' ? 'r' : 'p';
    result.openout_any = 'p';
    result.shell_escape = 'f';
  }

  return result;
}
