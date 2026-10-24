import { ChildProcess, spawn } from 'child_process';
import { Logger } from '@nestjs/common';
import {
  ISandboxRunner,
  ProcessExecutionOptions,
  ProcessExecutionResult,
} from '../../domain/clsi-ports';
import { Watchdog, killProcessGroup } from './process-watchdog';
import { buildSandboxEnv } from '../../domain/sandbox-env.builder';
import { getSafeHostEnv } from '../../../core/config/manuscripts.config';

export class LocalProcessRunner implements ISandboxRunner {
  readonly name = 'local-process';
  private static readonly logger = new Logger(LocalProcessRunner.name);

  private static readonly activeChildProcesses = new Set<ChildProcess>();
  private static shutdownHooksRegistered = false;

  private static registerShutdownHooks(): void {
    if (this.shutdownHooksRegistered) return;
    this.shutdownHooksRegistered = true;

    const cleanup = () => {
      for (const child of this.activeChildProcesses) {
        if (child.pid && !child.killed) {
          killProcessGroup(child.pid, true);
        }
      }
      this.activeChildProcesses.clear();
    };

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
    process.once('exit', cleanup);
  }

  public async run(
    command: string,
    args: string[],
    options: ProcessExecutionOptions,
  ): Promise<ProcessExecutionResult> {
    LocalProcessRunner.registerShutdownHooks();

    const isTexCommand = command !== 'docker' && command !== 'taskkill';
    if (isTexCommand) {
      LocalProcessRunner.logger.warn(
        'Executing compile process in local-unsafe mode without container isolation.',
      );
    }

    const filteredEnv = buildSandboxEnv({
      parentEnv: getSafeHostEnv(),
      extraEnv: options.env,
      clientAllowList: ['DOCKER_HOST', 'DOCKER_CONTEXT'],
      isTexProcess: isTexCommand,
    });

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';

      const child = spawn(command, args, {
        cwd: options.cwd,
        env: filteredEnv,
        detached: process.platform !== 'win32',
        shell: false,
      });

      LocalProcessRunner.activeChildProcesses.add(child);

      const watchdog = new Watchdog(child, options.timeoutMs ?? 240000);
      watchdog.arm(options.signal);

      child.stdout?.on('data', (data) => {
        const str = data.toString();
        stdout += str;
        options.onLogChunk?.(str);
      });

      child.stderr?.on('data', (data) => {
        const str = data.toString();
        stderr += str;
        options.onLogChunk?.(str);
      });

      child.on('error', (err) => {
        LocalProcessRunner.activeChildProcesses.delete(child);
        watchdog.disarm();
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr ? `${stderr}\n${err.message}` : err.message,
        });
      });

      child.on('close', (code) => {
        LocalProcessRunner.activeChildProcesses.delete(child);
        watchdog.disarm();
        if (watchdog.isAborted()) {
          const timeoutAdvice =
            '\n\n[Compilation Timeout — Troubleshooting Suggestions]\n' +
            'Your compilation timed out. Common causes and solutions:\n' +
            '  1. Infinite loops or recursion in custom macros, TikZ code, or complex tables.\n' +
            '  2. Very large, uncompressed high-resolution images (switch to "Draft mode" in Settings).\n' +
            '  3. Unclosed environments, braces, or math delimiters.\n' +
            '  4. Corrupted auxiliary files (click "Clear cached files" in Settings).';
          resolve({
            exitCode: 137,
            stdout,
            stderr: stderr
              ? `${stderr}\nCompilation timed out or was canceled.${timeoutAdvice}`
              : `Compilation timed out or was canceled.${timeoutAdvice}`,
          });
          return;
        }

        resolve({
          exitCode: code ?? 0,
          stdout,
          stderr,
        });
      });
    });
  }
}
