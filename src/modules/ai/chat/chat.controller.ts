import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ChatService } from './chat.service';
import { ChatQueryDto } from './dto/chat.dto';
import { JwtAuthGuard } from '@/modules/iam/authentication';
import { CurrentUser } from '@/modules/iam/authentication';

@ApiTags('AI - Assistant')
@ApiBearerAuth('JWT-auth')
@Controller('api/ai')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get('health')
  @ApiOperation({ summary: 'Check AI service connectivity' })
  async health() {
    return this.chatService.health();
  }

  @Post('chat')
  @Post('chat/sync')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Execute synchronous RAG chat query' })
  async chatSync(@CurrentUser('id') userId: string, @Body() dto: ChatQueryDto) {
    return this.chatService.chatSync(userId, dto);
  }

  @Get('documents')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get indexed documents from AI engine' })
  async getDocuments() {
    return this.chatService.getDocuments();
  }

  @Get('documents/bulk')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get bulk indexed documents' })
  async getDocumentBulk(@Query('ids') ids: string) {
    const idList = ids ? ids.split(',') : [];
    return this.chatService.getDocumentBulk(idList);
  }

  @Get('documents/:docId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get specific document details from AI engine' })
  async getDocument(@Param('docId') docId: string) {
    return this.chatService.getDocument(docId);
  }
}
