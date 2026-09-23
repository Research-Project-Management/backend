/**
 * modules/manuscripts/clsi/core/adapters/runners/watchdog.ts
 * Manages timeouts and guarantees termination with graceful SIGTERM followed by SIGKILL
 */

import { ChildProcess, spawn } from 'child_process';

export function killProcessGroup(pid: number, force = false): void {
  if (process.platform === 'win32') {
    try {
      const args = ['/T', '/PID', pid.toString()];
      if (force) {
        args.unshift('/F');
      }
      spawn('taskkill', args, { stdio: 'ignore' });
    } catch {
      // Process might already be dead
    }
  } else {
    try {
      // Target the process group using negative PID
      process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch (e: any) {
      if (e.code === 'ESRCH') return;
      // Fallback to single process if process group kill fails
      try {
        process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        // Process might already be dead
      }
    }
  }
}

export class Watchdog {
  private timeoutTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private aborted = false;
  private abortReason?: string;

  constructor(
    private readonly child: ChildProcess,
    private readonly timeoutMs: number = 30000,
    private readonly gracePeriodMs: number = 2000
  ) {}

  public arm(signal?: AbortSignal): void {
    if (signal) {
      if (signal.aborted) {
        this.terminate('ABORTED_IMMEDIATELY');
        return;
      }
      signal.addEventListener('abort', () => this.terminate('SIGNAL_ABORTED'), {
        once: true,
      });
    }

    this.timeoutTimer = setTimeout(() => {
      this.terminate('TIMEOUT');
    }, this.timeoutMs);
  }

  public disarm(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }

  public isAborted(): boolean {
    return this.aborted;
  }

  public getAbortReason(): string | undefined {
    return this.abortReason;
  }

  public terminate(reason: string): void {
    if (this.aborted) return;
    this.aborted = true;
    this.abortReason = reason;

    const pid = this.child.pid;
    if (!pid) return;

    killProcessGroup(pid, false);

    this.killTimer = setTimeout(() => {
      killProcessGroup(pid, true);
    }, this.gracePeriodMs);
  }
}

