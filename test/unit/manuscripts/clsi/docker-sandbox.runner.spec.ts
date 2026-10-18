/**
 * test/unit/manuscripts/clsi/docker-sandbox.runner.spec.ts
 * Verifies that DockerSandboxRunner synthesizes hardened container arguments,
 * enforces non-root execution, read-only rootfs, tmpfs, ulimits, network none,
 * and executes active container abort cleanup.
 */

import { DockerSandboxRunner } from '../../../../src/modules/manuscripts/clsi/services/sandbox/docker-sandbox.runner';
import {
  ISandboxRunner,
  ProcessExecutionOptions,
  ProcessExecutionResult,
} from '../../../../src/modules/manuscripts/clsi/domain/clsi-ports';
import { SandboxUnavailableException } from '../../../../src/modules/manuscripts/clsi/domain/sandbox-errors';
import { DEFAULT_SANDBOX_PROFILE } from '../../../../src/modules/manuscripts/clsi/domain/sandbox-profile';

class MockLocalRunner implements ISandboxRunner {
  readonly name = 'mock-local-runner';
  public runs: Array<{ command: string; args: string[]; options: ProcessExecutionOptions }> = [];
  public returnResult: ProcessExecutionResult = {
    exitCode: 0,
    stdout: 'Compilation complete',
    stderr: '',
  };

  public async run(
    command: string,
    args: string[],
    options: ProcessExecutionOptions,
  ): Promise<ProcessExecutionResult> {
    this.runs.push({ command, args, options });
    return this.returnResult;
  }
}

describe('DockerSandboxRunner Hardening & Lifecycle (Slice S3 / US2)', () => {
  let mockLocalRunner: MockLocalRunner;
  let runner: DockerSandboxRunner;

  beforeEach(() => {
    mockLocalRunner = new MockLocalRunner();
    runner = new DockerSandboxRunner(
      'sharelatex/clsi@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      '1024m',
      '1.0',
      mockLocalRunner,
    );
  });

  it('should synthesize all mandatory hardened container arguments', async () => {
    await runner.run('latexmk', ['-v'], {
      cwd: '/workspace/proj-123',
      runId: 'req-456',
      profile: DEFAULT_SANDBOX_PROFILE,
    });

    expect(mockLocalRunner.runs.length).toBe(1);
    const run = mockLocalRunner.runs[0];
    expect(run.command).toBe('docker');

    const args = run.args;
    expect(args).toContain('run');
    expect(args).toContain('--rm');
    expect(args).toContain('--name=flux-clsi-req-456');
    expect(args).toContain('--user=65534:65534');
    expect(args).toContain('--read-only');
    expect(args).toContain('--tmpfs=/tmp:rw,noexec,nosuid,size=256m');
    expect(args).toContain('--network=none');
    expect(args).toContain('--memory=1073741824b');
    expect(args).toContain('--memory-swap=1073741824b');
    expect(args).toContain('--cpus=1');
    expect(args).toContain('--pids-limit=100');
    expect(args).toContain('--ulimit=fsize=268435456');
    expect(args).toContain('--ulimit=nofile=1024:1024');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges');
    expect(args).toContain('-v');
    expect(args).toContain('/workspace/proj-123:/compile:rw');
    expect(args).toContain('-w');
    expect(args).toContain('/compile');
  });

  it('should pass optional runtime argument when runtime is defined in profile', async () => {
    const profileWithRuntime = {
      ...DEFAULT_SANDBOX_PROFILE,
      runtime: 'runsc',
    };

    await runner.run('latexmk', ['-v'], {
      cwd: '/workspace/proj-123',
      runId: 'req-789',
      profile: profileWithRuntime,
    });

    const run = mockLocalRunner.runs[0];
    expect(run.args).toContain('--runtime=runsc');
  });

  it('should trigger docker kill and rm on abort signal', async () => {
    const controller = new AbortController();

    mockLocalRunner.returnResult = {
      exitCode: 137,
      stdout: '',
      stderr: 'Canceled',
      timedOut: true,
    };

    const runPromise = runner.run('latexmk', ['main.tex'], {
      cwd: '/workspace/proj-123',
      runId: 'req-abort',
      signal: controller.signal,
    });

    // Abort during run
    controller.abort();
    await runPromise;

    const killRun = mockLocalRunner.runs.find(
      (r) => r.args[0] === 'kill' && r.args[1] === 'flux-clsi-req-abort',
    );
    expect(killRun).toBeDefined();

    const rmRun = mockLocalRunner.runs.find(
      (r) => r.args[0] === 'rm' && r.args.includes('flux-clsi-req-abort'),
    );
    expect(rmRun).toBeDefined();
  });

  it('should throw SandboxUnavailableException when docker binary is missing', async () => {
    mockLocalRunner.returnResult = {
      exitCode: 127,
      stdout: '',
      stderr: 'docker: command not found',
    };

    await expect(
      runner.run('latexmk', ['-v'], {
        cwd: '/workspace/proj-123',
      }),
    ).rejects.toThrow(SandboxUnavailableException);
  });
});
