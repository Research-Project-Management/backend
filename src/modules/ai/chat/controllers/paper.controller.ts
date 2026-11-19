import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { BypassEnvelope } from '@/core';
import { CurrentUser, JwtAuthGuard } from '@/modules/identity/auth';
import { QueryDto } from '../dto/query.dto';
import { PaperChatService } from '../services/paper.service';

@ApiTags('AI - Paper Q&A')
@ApiBearerAuth('JWT-auth')
@Controller('api/ai')
@UseGuards(JwtAuthGuard)
export class PaperController {
  constructor(private readonly paperChatService: PaperChatService) {}

  @Post(['papers/:paperId/chat', 'files/:paperId/chat'])
  @BypassEnvelope()
  @ApiOperation({ summary: 'Stream paper/file-scoped RAG responses via SSE' })
  async streamPaper(
    @CurrentUser('id') userId: string,
    @Param('paperId') paperId: string,
    @Body() dto: QueryDto,
    @Res() reply: FastifyReply,
    @Headers('authorization') authorization?: string,
  ) {
    return this.paperChatService.stream(
      userId,
      paperId,
      dto,
      reply,
      authorization,
    );
  }

  @Post(['papers/:paperId/chat/sync', 'files/:paperId/chat/sync'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Synchronous paper/file-scoped RAG query' })
  async executePaper(
    @CurrentUser('id') userId: string,
    @Param('paperId') paperId: string,
    @Body() dto: QueryDto,
    @Headers('authorization') authorization?: string,
  ) {
    return this.paperChatService.execute(userId, paperId, dto, authorization);
  }
}
