import { randomUUID } from 'crypto';
import {
  ISandboxRunner,
  ProcessExecutionOptions,
  ProcessExecutionResult,
} from '../../domain/clsi-ports';
import { LocalProcessRunner } from './local-process.runner';
import { buildSandboxEnv } from '../../domain/sandbox-env.builder';
import { getSafeHostEnv } from '../../../core/config/manuscripts.config';
import { SandboxUnavailableException } from '../../domain/sandbox-errors';
import {
  DEFAULT_SANDBOX_PROFILE,
  SandboxProfile,
} from '../../domain/sandbox-profile';

export class DockerSandboxRunner implements ISandboxRunner {
  readonly name = 'docker-sandbox';
  private readonly localRunner: ISandboxRunner;

  constructor(
    private readonly dockerImage: string = 'sharelatex/clsi:latest',
    private readonly memoryLimit: string = '1024m',
    private readonly cpuLimit: string = '1.0',
    localRunner?: ISandboxRunner,
    private readonly defaultProfile?: SandboxProfile,
  ) {
    this.localRunner = localRunner ?? new LocalProcessRunner();
  }

  private parseMemoryLimitBytes(limit: string): number {
    const trimmed = limit.trim().toLowerCase();
    const match = /^(\d+(?:\.\d+)?)\s*([kmg]b?)?$/.exec(trimmed);
    if (!match) {
      return DEFAULT_SANDBOX_PROFILE.memoryBytes;
    }
    const val = parseFloat(match[1]);
    const unit = match[2] || '';
    if (unit.startsWith('g')) return Math.round(val * 1024 * 1024 * 1024);
    if (unit.startsWith('m')) return Math.round(val * 1024 * 1024);
    if (unit.startsWith('k')) return Math.round(val * 1024);
    return Math.round(val);
  }

  private resolveDefaultProfile(): SandboxProfile {
    if (this.defaultProfile) {
      return Object.freeze({ ...this.defaultProfile });
    }
    const parsedCpus = parseFloat(this.cpuLimit);
    return Object.freeze({
      ...DEFAULT_SANDBOX_PROFILE,
      memoryBytes: this.parseMemoryLimitBytes(this.memoryLimit),
      cpus:
        Number.isFinite(parsedCpus) && parsedCpus > 0
          ? parsedCpus
          : DEFAULT_SANDBOX_PROFILE.cpus,
    });
  }

  public async run(
    command: string,
    args: string[],
    options: ProcessExecutionOptions,
  ): Promise<ProcessExecutionResult> {
    const profile: SandboxProfile =
      options.profile ?? this.resolveDefaultProfile();
    const runId = options.runId || randomUUID();
    const containerName = `flux-clsi-${runId}`;

    const filteredEnv = buildSandboxEnv({
      parentEnv: getSafeHostEnv(),
      extraEnv: options.env,
      isTexProcess: true,
    });

    const envArgs: string[] = [];
    const isTexSearchPathKey = (key: string) =>
      key === 'TEXINPUTS' || key === 'BIBINPUTS' || key === 'BSTINPUTS';

    for (const [k, v] of Object.entries(filteredEnv)) {
      if (v !== undefined) {
        let containerVal =
          typeof v === 'string'
            ? v.split(options.cwd).join('/compile').replace(/\\/g, '/')
            : String(v);
        if (isTexSearchPathKey(k)) {
          // Linux container kpathsea requires ':' path separator and '//' recursive suffix
          containerVal = containerVal
            .replace(/\/{3,}/g, '//')
            .replace(/;/g, ':');
        }
        envArgs.push('-e', `${k}=${containerVal}`);
      }
    }

    const dockerArgs = [
      'run',
      '--rm',
      '--init',
      `--name=${containerName}`,
      `--user=${profile.user}`,
      ...(profile.readOnlyRootfs ? ['--read-only'] : []),
      `--tmpfs=${profile.tmpfs.mountPath}:${profile.tmpfs.options}`,
      `--network=${profile.network}`,
      `--memory=${profile.memoryBytes}b`,
      `--memory-swap=${profile.memoryBytes}b`,
      `--cpus=${profile.cpus}`,
      `--pids-limit=${profile.pidsLimit}`,
      `--ulimit=fsize=${profile.maxFileSizeBytes}`,
      `--ulimit=nofile=${profile.maxOpenFiles}:${profile.maxOpenFiles}`,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      ...(profile.runtime ? [`--runtime=${profile.runtime}`] : []),
      '-v',
      `${options.cwd}:/compile:rw`,
      '-w',
      '/compile',
      ...envArgs,
      this.dockerImage,
      command,
      ...args,
    ];

    const cleanupContainer = async (): Promise<void> => {
      try {
        await this.localRunner.run('docker', ['kill', containerName], {
          cwd: options.cwd,
          timeoutMs: 5000,
        });
      } catch {}
      try {
        await this.localRunner.run('docker', ['rm', '-f', containerName], {
          cwd: options.cwd,
          timeoutMs: 5000,
        });
      } catch {}
    };

    let cleanupTriggered = false;
    const onAbort = () => {
      if (!cleanupTriggered) {
        cleanupTriggered = true;
        cleanupContainer().catch(() => {});
      }
    };

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    try {
      const result = await this.localRunner.run('docker', dockerArgs, options);

      if (
        result.exitCode !== 0 &&
        result.stderr.includes('docker: command not found')
      ) {
        throw new SandboxUnavailableException(
          'Compilation is temporarily unavailable.',
          'Docker is not installed or available on this system',
        );
      }

      if (result.timedOut || result.killed) {
        await cleanupContainer();
      }

      return result;
    } catch (err: unknown) {
      await cleanupContainer();
      throw err;
    }
  }
}
