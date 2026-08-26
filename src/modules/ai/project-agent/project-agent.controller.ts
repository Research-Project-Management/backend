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
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { BypassEnvelope } from '@/core/decorators/bypass-envelope.decorator';

@ApiTags('AI - Project Agent')
@ApiBearerAuth('JWT-auth')
@Controller('api/ai')
@UseGuards(JwtAuthGuard)
export class ProjectAgentController {
  constructor(private readonly projectAgentService: ProjectAgentService) {}

  @Post(['chat/project', 'project/chat'])
  @BypassEnvelope()
  @ApiOperation({ summary: 'Stream Project Agent chat responses via SSE' })
  async chatStream(
    @CurrentUser('id') userId: string,
    @Body() dto: ProjectAgentQueryDto,
    @Res() reply: FastifyReply,
  ) {
    return this.projectAgentService.streamProjectChat(userId, dto, reply);
  }

  @Post(['chat/project/sync', 'project/chat/sync'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Execute synchronous Project Agent query' })
  async chatSync(
    @CurrentUser('id') userId: string,
    @Body() dto: ProjectAgentQueryDto,
  ) {
    return this.projectAgentService.syncProjectChat(userId, dto);
  }
}
