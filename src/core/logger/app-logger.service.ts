import { Injectable, LoggerService, LogLevel } from '@nestjs/common';
import { ANSI, ChocolateTheme } from './chocolate-theme.constant';

@Injectable()
export class AppLogger implements LoggerService {
  private static instance: AppLogger;
  private contextName: string = 'Application';
  private logLevels: Set<LogLevel> = new Set([
    'log',
    'error',
    'warn',
    'debug',
    'verbose',
  ]);

  constructor(context?: string) {
    if (context) {
      this.contextName = context;
    }
  }

  /**
   * Singleton Pattern Accessor
   */
  public static getInstance(context?: string): AppLogger {
    if (!AppLogger.instance) {
      AppLogger.instance = new AppLogger(context);
    } else if (context) {
      AppLogger.instance.setContext(context);
    }
    return AppLogger.instance;
  }

  public setContext(context: string): this {
    this.contextName = context;
    return this;
  }

  public setLogLevels(levels: LogLevel[]): void {
    this.logLevels = new Set(levels);
  }

  private formatTimestamp(): string {
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${now.getMilliseconds().toString().padStart(3, '0')}`;
    return ChocolateTheme.timestamp(time);
  }

  private formatMessage(message: unknown): string {
    if (typeof message === 'string') {
      return message;
    }
    if (typeof message === 'number' || typeof message === 'boolean') {
      return message.toString();
    }
    if (message instanceof Error) {
      return message.stack || message.message;
    }
    if (typeof message === 'object' && message !== null) {
      try {
        return JSON.stringify(message, null, 2);
      } catch {
        return Object.prototype.toString.call(message);
      }
    }
    return '';
  }

  log(message: unknown, context?: string) {
    if (!this.logLevels.has('log')) return;
    const ctx = context || this.contextName;
    const badge = ChocolateTheme.badge('INFO', ANSI.caramel);
    const ctxBadge = ChocolateTheme.context(ctx);
    console.log(
      `${this.formatTimestamp()} ${badge} ${ctxBadge} ${this.formatMessage(message)}`,
    );
  }

  error(message: unknown, trace?: string, context?: string) {
    if (!this.logLevels.has('error')) return;
    const ctx = context || this.contextName;
    const badge = ChocolateTheme.badge('ERROR', ANSI.errorCrimson);
    const ctxBadge = ChocolateTheme.context(ctx);
    console.error(
      `${this.formatTimestamp()} ${badge} ${ctxBadge} ${ANSI.errorRuby}${this.formatMessage(message)}${ANSI.reset}`,
    );
    if (trace) {
      console.error(`${ANSI.dim}${trace}${ANSI.reset}`);
    }
  }

  warn(message: unknown, context?: string) {
    if (!this.logLevels.has('warn')) return;
    const ctx = context || this.contextName;
    const badge = ChocolateTheme.badge('WARN', ANSI.warnAmber);
    const ctxBadge = ChocolateTheme.context(ctx);
    console.warn(
      `${this.formatTimestamp()} ${badge} ${ctxBadge} ${ANSI.cinnamon}${this.formatMessage(message)}${ANSI.reset}`,
    );
  }

  debug(message: unknown, context?: string) {
    if (!this.logLevels.has('debug')) return;
    const ctx = context || this.contextName;
    const badge = ChocolateTheme.badge('DEBUG', ANSI.debugCyan);
    const ctxBadge = ChocolateTheme.context(ctx);
    console.debug(
      `${this.formatTimestamp()} ${badge} ${ctxBadge} ${this.formatMessage(message)}`,
    );
  }

  verbose(message: unknown, context?: string) {
    if (!this.logLevels.has('verbose')) return;
    const ctx = context || this.contextName;
    const badge = ChocolateTheme.badge('VERBOSE', ANSI.mocha);
    const ctxBadge = ChocolateTheme.context(ctx);
    console.log(
      `${this.formatTimestamp()} ${badge} ${ctxBadge} ${this.formatMessage(message)}`,
    );
  }

  http(
    method: string,
    url: string,
    statusCode: number,
    durationMs: number,
    requestId?: string,
  ) {
    const badge = ChocolateTheme.badge('HTTP', ANSI.milkChocolate);
    const methodStr = ChocolateTheme.method(method);
    const statusStr = ChocolateTheme.status(statusCode);
    const durStr = ChocolateTheme.duration(durationMs);
    const reqStr = requestId ? ChocolateTheme.requestId(requestId) + ' ' : '';
    console.log(
      `${this.formatTimestamp()} ${badge} ${reqStr}${methodStr} ${url} ${statusStr} ${durStr}`,
    );
  }
}
