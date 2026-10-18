import { Injectable, Logger } from '@nestjs/common';

export interface RealtimeStats {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptime: number;
}

@Injectable()
export class CoreService {
  private readonly logger = new Logger(CoreService.name);
  private readonly startTime = Date.now();

  public getStats(): RealtimeStats {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }
}
