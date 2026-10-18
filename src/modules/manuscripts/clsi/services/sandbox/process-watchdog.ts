import { ChildProcess, spawn } from 'child_process';

/**
 * Terminates a process group cross-platform.
 * On Windows: uses taskkill /F /T /PID.
 * On POSIX: sends SIGTERM/SIGKILL to process group (-pid).
 */
export function killProcessGroup(pid: number, force = false): void {
  if (process.platform === 'win32') {
    try {
      const args = ['/F', '/T', '/PID', pid.toString()];
      spawn('taskkill', args, { stdio: 'ignore' });
    } catch {
      // ignore
    }
  } else {
    try {
      process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === 'ESRCH') return;
      try {
        process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Monitors a child process lifecycle, enforcing wall-clock timeout
 * and abort signal listener with graceful-to-forceful process group kill.
 */
export class Watchdog {
  private timeoutTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private aborted = false;
  private abortReason?: string;

  constructor(
    private readonly child: ChildProcess,
    private readonly timeoutMs: number = 240000,
    private readonly gracePeriodMs: number = 2000,
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
