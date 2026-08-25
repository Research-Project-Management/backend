import {
  Controller,
  Post,
  Body,
  UseGuards,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import { ProjectAgentService } from './project-agent.service';
import { ProjectAgentQueryDto } from './dto/project-agent.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authn';

@ApiTags('AI - Project Agent')
@ApiBearerAuth('JWT-auth')
@Controller('api/ai')
@UseGuards(JwtAuthGuard)
export class ProjectAgentController {
  constructor(private readonly projectAgentService: ProjectAgentService) {}

  @Post(['chat', 'chat/project'])
  @ApiOperation({ summary: 'Stream Project Agent chat responses via SSE' })
  async chatStream(
    @CurrentUser('id') userId: string,
    @Body() dto: ProjectAgentQueryDto,
    @Res() reply: FastifyReply,
  ) {
    return this.projectAgentService.streamProjectChat(userId, dto, reply);
  }

  @Post('chat/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Execute synchronous Project Agent query' })
  async chatSync(
    @CurrentUser('id') userId: string,
    @Body() dto: ProjectAgentQueryDto,
  ) {
    return this.projectAgentService.syncProjectChat(userId, dto);
  }
}
