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
import { WritingAgentService } from './writing-agent.service';
import { WritingAgentQueryDto } from './dto/writing-agent.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authn';

@ApiTags('AI - Writing Agent')
@ApiBearerAuth('JWT-auth')
@Controller('api/ai')
@UseGuards(JwtAuthGuard)
export class WritingAgentController {
  constructor(private readonly writingAgentService: WritingAgentService) {}

  @Post(['editor-chat', 'chat/writing', 'writing/chat'])
  @ApiOperation({
    summary: 'Stream LaTeX Writing Agent chat responses via SSE',
  })
  async chatStream(
    @CurrentUser('id') userId: string,
    @Body() dto: WritingAgentQueryDto,
    @Res() reply: FastifyReply,
  ) {
    return this.writingAgentService.streamWritingChat(userId, dto, reply);
  }

  @Post(['editor-chat/sync', 'chat/writing/sync', 'writing/chat/sync'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Execute synchronous Writing Agent query' })
  async chatSync(
    @CurrentUser('id') userId: string,
    @Body() dto: WritingAgentQueryDto,
  ) {
    return this.writingAgentService.syncWritingChat(userId, dto);
  }
}
