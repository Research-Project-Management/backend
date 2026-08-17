import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('AI - Health')
@Controller('api/ai')
export class AiHealthController {
  @Get('health')
  @ApiOperation({ summary: 'AI subsystem health' })
  health() {
    return { status: 'ok', service: 'ai' };
  }
}
