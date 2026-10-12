import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  getStatus() {
    return {
      status: 'ok',
      service: 'flux-api',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
    };
  }
}
