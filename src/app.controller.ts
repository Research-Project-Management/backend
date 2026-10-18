import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('System')
@Controller()
export class AppController {
  @Get()
  @ApiOperation({ summary: 'Check API service health status' })
  @ApiResponse({ status: 200, description: 'API service is running correctly' })
  getStatus() {
    return {
      status: 'ok',
      service: 'flux-api',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
    };
  }
}
