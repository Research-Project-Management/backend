import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { FastifyRequest, FastifyReply } from 'fastify';
import { RagAgentService } from './rag-agent.service';
import { RagAgentQueryDto } from './dto/rag-agent.dto';
import {
  JwtAuthGuard,
  CurrentUser,
  Public,
} from '@/modules/iam/authn';

@ApiTags('AI - RAG Agent')
@ApiBearerAuth('JWT-auth')
@Controller('api/ai')
@UseGuards(JwtAuthGuard)
export class RagAgentController {
  constructor(private readonly ragAgentService: RagAgentService) {}

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'AI service health check' })
  health() {
    return {
      status: 'ok',
      service: 'flux-ai-engine',
      timestamp: new Date().toISOString(),
    };
  }

  @Post(['chat/rag', 'rag/chat'])
  @ApiOperation({ summary: 'Stream RAG Agent chat responses via SSE' })
  async chatStream(
    @CurrentUser('id') userId: string,
    @Body() dto: RagAgentQueryDto,
    @Req() _req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.ragAgentService.streamRagChat(userId, dto, reply);
  }

  @Post(['chat/rag/sync', 'rag/chat/sync'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Synchronous RAG Agent chat' })
  async chatSync(
    @CurrentUser('id') userId: string,
    @Body() dto: RagAgentQueryDto,
  ) {
    return this.ragAgentService.syncRagChat(userId, dto);
  }

  @Post('paper/:paperId/chat')
  @ApiOperation({ summary: 'Stream paper-scoped RAG chat responses via SSE' })
  async paperChatStream(
    @CurrentUser('id') userId: string,
    @Param('paperId') paperId: string,
    @Body() dto: RagAgentQueryDto,
    @Req() _req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.ragAgentService.streamPaperChat(userId, paperId, dto, reply);
  }

  @Post('paper/:paperId/chat/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Synchronous paper-scoped RAG chat' })
  async paperChatSync(
    @CurrentUser('id') userId: string,
    @Param('paperId') paperId: string,
    @Body() dto: RagAgentQueryDto,
  ) {
    return this.ragAgentService.syncPaperChat(userId, paperId, dto);
  }

  @Get('documents')
  @ApiOperation({ summary: 'List all RAG documents' })
  async getDocuments() {
    return this.ragAgentService.getDocuments();
  }

  @Get('documents/:docId')
  @ApiOperation({ summary: 'Get document details from RAG engine' })
  async getDocument(@Param('docId') docId: string) {
    return this.ragAgentService.getDocument(docId);
  }
}
