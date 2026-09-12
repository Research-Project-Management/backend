import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { AttachmentService } from './attachment.service';
import { PresignAttachmentDto } from './dto/presign-attachment.dto';
import { CreateAttachmentDto } from './dto/create-attachment.dto';
import { QueryAttachmentDto } from './dto/query-attachment.dto';

@ApiTags('attachments')
@ApiBearerAuth('JWT-auth')
@Controller('api/attachments')
@UseGuards(JwtAuthGuard)
export class AttachmentController {
  constructor(private readonly attachmentService: AttachmentService) {}

  @Post('presign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate presigned URL for direct attachment upload (task, comment, page, sticky, etc.)',
  })
  async presign(
    @Body() dto: PresignAttachmentDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentService.generatePresignedUpload(dto, userId);
  }

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Multipart stream upload attachment directly to server/storage',
  })
  async upload(
    @Req() req: FastifyRequest,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentService.uploadMultipart(req, userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register attachment record after client uploaded via presigned URL',
  })
  async create(
    @Body() dto: CreateAttachmentDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentService.createAttachment(dto, userId);
  }

  @Get()
  @ApiOperation({
    summary: 'Query attachments with entityType, entityId, workspaceId, or projectId filters',
  })
  async getMany(@Query() query: QueryAttachmentDto) {
    return this.attachmentService.getAttachments(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single attachment metadata by ID' })
  @ApiParam({ name: 'id', description: 'Attachment UUID' })
  async getOne(@Param('id') id: string) {
    return this.attachmentService.getAttachmentById(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete attachment by ID (removes record & storage object)' })
  @ApiParam({ name: 'id', description: 'Attachment UUID' })
  async delete(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.attachmentService.deleteAttachment(id, userId);
  }
}
