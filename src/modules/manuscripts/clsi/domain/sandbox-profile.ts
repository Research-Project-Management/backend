/**
 * modules/manuscripts/clsi/domain/sandbox-profile.ts
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
