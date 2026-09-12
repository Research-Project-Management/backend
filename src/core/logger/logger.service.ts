import {
  Injectable,
  LoggerService as NestLoggerService,
  LogLevel,
} from '@nestjs/common';

@Injectable()
export class LoggerService implements NestLoggerService {
  private static instance: LoggerService;
  private contextName = 'Application';
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
  public static getInstance(context?: string): LoggerService {
    if (!LoggerService.instance) {
      LoggerService.instance = new LoggerService(context);
    } else if (context) {
      LoggerService.instance.setContext(context);
    }
    return LoggerService.instance;
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
    const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${now.getMilliseconds().toString().padStart(3, '0')}`;
    return `[${time}]`;
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
    console.log(
      `${this.formatTimestamp()} [INFO] [${ctx}] ${this.formatMessage(message)}`,
    );
  }

  error(message: unknown, trace?: string, context?: string) {
    if (!this.logLevels.has('error')) return;
    const ctx = context || this.contextName;
    console.error(
      `${this.formatTimestamp()} [ERROR] [${ctx}] ${this.formatMessage(message)}`,
    );
    if (trace) {
      console.error(trace);
    }
  }

  warn(message: unknown, context?: string) {
    if (!this.logLevels.has('warn')) return;
    const ctx = context || this.contextName;
    console.warn(
      `${this.formatTimestamp()} [WARN] [${ctx}] ${this.formatMessage(message)}`,
    );
  }

  debug(message: unknown, context?: string) {
    if (!this.logLevels.has('debug')) return;
    const ctx = context || this.contextName;
    console.debug(
      `${this.formatTimestamp()} [DEBUG] [${ctx}] ${this.formatMessage(message)}`,
    );
  }

  verbose(message: unknown, context?: string) {
    if (!this.logLevels.has('verbose')) return;
    const ctx = context || this.contextName;
    console.log(
      `${this.formatTimestamp()} [VERBOSE] [${ctx}] ${this.formatMessage(message)}`,
    );
  }

  http(
    method: string,
    url: string,
    statusCode: number,
    durationMs: number,
    requestId?: string,
  ) {
    const reqStr = requestId ? `[${requestId}] ` : '';
    console.log(
      `${this.formatTimestamp()} [HTTP] ${reqStr}${method.toUpperCase()} ${url} ${statusCode} +${durationMs}ms`,
    );
  }
}

export const AppLogger = LoggerService;
