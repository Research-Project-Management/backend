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
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AiService } from './ai.service';
import { ChatQueryDto } from './dto/ai.dto';
import { JwtAuthGuard } from '@/core/guards/jwt-auth.guard';
import { CurrentUser } from '@/core/decorators/current-user.decorator';

@ApiTags('Intelligence')
@ApiBearerAuth('JWT-auth')
@Controller('api/ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Get('health')
  async health() {
    return this.aiService.health();
  }

  @Post('chat')
  @Post('chat/sync')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async chatSync(@CurrentUser('id') userId: string, @Body() dto: ChatQueryDto) {
    return this.aiService.chatSync(userId, dto);
  }

  @Get('documents')
  @UseGuards(JwtAuthGuard)
  async getDocuments() {
    return this.aiService.getDocuments();
  }

  @Get('documents/bulk')
  @UseGuards(JwtAuthGuard)
  async getDocumentBulk(@Query('ids') ids: string) {
    const idList = ids ? ids.split(',') : [];
    return this.aiService.getDocumentBulk(idList);
  }

  @Get('documents/:docId')
  @UseGuards(JwtAuthGuard)
  async getDocument(@Param('docId') docId: string) {
    return this.aiService.getDocument(docId);
  }
}
