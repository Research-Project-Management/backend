import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Optional,
  UseGuards,
  Req,
  Res,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BypassEnvelope } from '@/core';
import { AuthGuard, CurrentUser, Public } from '@/modules/identity/auth';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import { ChatService } from '../services/chat.service';
import { ChatAttachmentService } from '../services/chat-attachment.service';
import {
  CreateDirectConversationDto,
  CreateGroupConversationDto,
  SendMessageDto,
  AddReactionDto,
  GetMessagesQueryDto,
  PresignChatAttachmentDto,
  CompleteChatAttachmentDto,
} from '../dto/chat.dto';
import { extractMultipartSingleFile } from '@/modules/files/controllers/files-http.helper';
import { MAX_CHAT_FILE_BYTES } from '../chat.constant';

@ApiTags('Chat')
@ApiBearerAuth('JWT-auth')
@Controller(['api/chat', 'chat'])
@UseGuards(AuthGuard)
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatAttachmentService: ChatAttachmentService,
    @Optional() private readonly realtimeFacade?: RealtimeFacade,
  ) {}

  @Get('conversations')
  async getConversations(@CurrentUser('id') userId: string) {
    return this.chatService.getUserConversations(userId);
  }

  @Post('conversations/direct')
  async createDirect(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateDirectConversationDto,
  ) {
    return this.chatService.getOrCreateDirect(userId, dto.targetUserId);
  }

  @Post('conversations/group')
  async createGroup(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateGroupConversationDto,
  ) {
    return this.chatService.createGroup(userId, dto);
  }

  @Get('conversations/:id/messages')
  async getMessages(
    @Param('id') conversationId: string,
    @CurrentUser('id') userId: string,
    @Query() query: GetMessagesQueryDto,
  ) {
    const limit = query.limit ? parseInt(query.limit, 10) : 25;
    return this.chatService.getMessages(
      conversationId,
      userId,
      query.cursor,
      limit,
    );
  }

  @Post('conversations/:id/messages')
  async sendMessage(
    @Param('id') conversationId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: SendMessageDto,
  ) {
    const message = await this.chatService.sendMessage(
      conversationId,
      userId,
      dto,
    );
    await this.realtimeFacade?.publishChatMessage(conversationId, message);
    return message;
  }

  // ─── Attachments & Media (Cloudflare R2 Direct Upload & Scale) ───────────

  @Post('conversations/:id/attachments/presign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Issue direct-to-R2 presigned PUT upload URL with per-file size validation',
  })
  async presignAttachment(
    @Param('id') conversationId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: PresignChatAttachmentDto,
  ) {
    return this.chatAttachmentService.createPresignedUpload(
      conversationId,
      userId,
      dto,
    );
  }

  @Post('conversations/:id/attachments/complete')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Finalize and record presigned upload into chat attachment payload',
  })
  async completeAttachment(
    @Param('id') conversationId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CompleteChatAttachmentDto,
  ) {
    return this.chatAttachmentService.completePresignedUpload(
      conversationId,
      userId,
      dto,
    );
  }

  @Post('conversations/:id/attachments/upload')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Direct multipart upload fallback for chat files (streamed to R2)',
  })
  async uploadAttachmentDirect(
    @Param('id') conversationId: string,
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
  ) {
    const { buffer, filename, mimeType } = await extractMultipartSingleFile(
      req,
      MAX_CHAT_FILE_BYTES,
    );
    return this.chatAttachmentService.uploadDirect(conversationId, userId, {
      buffer,
      filename,
      mimeType,
    });
  }

  @Get('attachments/stream')
  @Public()
  @BypassEnvelope()
  @ApiOperation({
    summary:
      'Stream or redirect (HTTP 302) chat attachment directly to Cloudflare R2',
  })
  async streamAttachment(
    @Query('key') storageKey: string,
    @Query('download') queryDownload: string | undefined,
    @Query('filename') queryFilename: string | undefined,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    const reqAuth = req as FastifyRequest & {
      user?: { id?: string; sub?: string };
    };
    const userId = reqAuth.user?.id || reqAuth.user?.sub || 'anonymous';
    const isDownload = queryDownload === 'true' || queryDownload === '1';

    const outcome = await this.chatAttachmentService.resolveAttachmentAccess(
      userId,
      storageKey,
      { download: isDownload, filename: queryFilename },
    );

    if (outcome.kind === 'redirect') {
      return res.status(HttpStatus.FOUND).redirect(outcome.url);
    }

    res.status(HttpStatus.OK);
    res.header('Content-Type', outcome.mimeType);
    if (outcome.contentLength !== undefined) {
      res.header('Content-Length', outcome.contentLength);
    }
    if (outcome.contentRange) {
      res.header('Content-Range', outcome.contentRange);
      res.status(HttpStatus.PARTIAL_CONTENT);
    }
    res.header('Accept-Ranges', 'bytes');
    res.header('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(outcome.stream);
  }

  // ─── Reactions & Receipts ───────────────────────────────────────────────

  @Post('conversations/:id/read')
  async markRead(
    @Param('id') conversationId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.chatService.markAsRead(conversationId, userId);
  }

  @Post('messages/:id/reactions')
  async addReaction(
    @Param('id') messageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: AddReactionDto,
  ) {
    const res = await this.chatService.addReaction(
      messageId,
      userId,
      dto.emoji,
    );
    await this.realtimeFacade?.publishChatReaction(res.conversationId, {
      conversationId: res.conversationId,
      messageId,
      userId,
      emoji: dto.emoji,
      action: 'add',
    });
    return res;
  }

  @Delete('messages/:id/reactions/:emoji')
  async removeReaction(
    @Param('id') messageId: string,
    @Param('emoji') emoji: string,
    @CurrentUser('id') userId: string,
  ) {
    const res = await this.chatService.removeReaction(messageId, userId, emoji);
    await this.realtimeFacade?.publishChatReaction(res.conversationId, {
      conversationId: res.conversationId,
      messageId,
      userId,
      emoji,
      action: 'remove',
    });
    return res;
  }
}
