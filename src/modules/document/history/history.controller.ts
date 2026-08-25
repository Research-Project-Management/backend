import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { HistoryService } from './history.service';
import { CreateVersionDto } from './dto/history.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authn';

@ApiTags('Document - History & Versions')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class HistoryController {
  constructor(private readonly historyService: HistoryService) {}

  @Get(['project/:projectId/pages/:pageId/versions', 'pages/:pageId/versions'])
  async getVersions(@Param('pageId') pageId: string) {
    return this.historyService.getVersions(pageId);
  }

  @Post(['project/:projectId/pages/:pageId/versions', 'pages/:pageId/versions'])
  @HttpCode(HttpStatus.CREATED)
  async createVersion(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateVersionDto,
  ) {
    return this.historyService.createVersion(pageId, userId, dto);
  }

  @Post([
    'project/:projectId/pages/:pageId/versions/:versionId/restore',
    'pages/:pageId/versions/:versionId/restore',
  ])
  @HttpCode(HttpStatus.OK)
  async restoreVersion(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.historyService.restoreVersion(pageId, versionId);
  }

  @Delete([
    'project/:projectId/pages/:pageId/versions/:versionId',
    'pages/:pageId/versions/:versionId',
  ])
  async deleteVersion(@Param('versionId') versionId: string) {
    return this.historyService.deleteVersion(versionId);
  }

  @Get(['project/:projectId/pages/:pageId/history', 'pages/:pageId/history'])
  async getHistory(@Param('pageId') pageId: string) {
    return this.historyService.getHistory(pageId);
  }

  @Post([
    'project/:projectId/pages/:pageId/history/:eventId/restore',
    'pages/:pageId/history/:eventId/restore',
  ])
  @HttpCode(HttpStatus.OK)
  async restoreHistory(
    @Param('pageId') pageId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.historyService.restoreVersion(pageId, eventId);
  }
}
