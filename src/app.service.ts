import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getStatus() {
    return {
      status: 'ok',
      service: 'flux-api',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
    };
  }
}
