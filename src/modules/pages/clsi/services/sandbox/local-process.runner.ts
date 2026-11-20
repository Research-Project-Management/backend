import { ChildProcess, spawn } from 'child_process';
import { Logger } from '@nestjs/common';
import {
  ISandboxRunner,
  ProcessExecutionOptions,
  ProcessExecutionResult,
} from '../../domain/clsi.ports';
import { Watchdog, killProcessGroup } from './process-watchdog';
import { buildSandboxEnv } from '../../domain/sandbox-env.builder';
import { getSafeHostEnv } from '../../../core/config/pages.config';

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
      openinAny: options.openinAny,
    });

    return new Promise((resolve) => {
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      const stderrChunks: Buffer[] = [];
      let stderrBytes = 0;
      const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;

      const recordStreamChunk = (
        raw: unknown,
        chunks: Buffer[],
        currentBytes: number,
      ): number => {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
        const remaining = maxOutputBytes - currentBytes;
        if (remaining <= 0) {
          return currentBytes;
        }
        const bounded =
          buf.byteLength > remaining ? buf.subarray(0, remaining) : buf;
        chunks.push(bounded);
        if (options.onLogChunk) {
          options.onLogChunk(bounded.toString('utf8'));
        }
        return currentBytes + bounded.byteLength;
      };

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
        stdoutBytes = recordStreamChunk(data, stdoutChunks, stdoutBytes);
      });

      child.stderr?.on('data', (data) => {
        stderrBytes = recordStreamChunk(data, stderrChunks, stderrBytes);
      });

      child.on('error', (err) => {
        LocalProcessRunner.activeChildProcesses.delete(child);
        watchdog.disarm();
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr ? `${stderr}\n${err.message}` : err.message,
        });
      });

      child.on('close', (code) => {
        LocalProcessRunner.activeChildProcesses.delete(child);
        watchdog.disarm();
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (watchdog.isAborted()) {
          const isTimeout = watchdog.getAbortReason() === 'TIMEOUT';
          if (isTimeout) {
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
                ? `${stderr}\nCompilation timed out.${timeoutAdvice}`
                : `Compilation timed out.${timeoutAdvice}`,
              timedOut: true,
              killed: true,
            });
            return;
          }

          resolve({
            exitCode: 137,
            stdout,
            stderr: stderr
              ? `${stderr}\nCompilation was cancelled.`
              : 'Compilation was cancelled.',
            timedOut: false,
            killed: true,
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
