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
import { VersionService } from './version.service';
import { CreateVersionDto } from './dto/version.dto';
import { JwtAuthGuard } from '@/core/guards/jwt-auth.guard';
import { CurrentUser } from '@/core/decorators/current-user.decorator';

@ApiTags('Manuscript')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class VersionController {
  constructor(private readonly versionService: VersionService) {}

  @Get(['project/:projectId/pages/:pageId/versions', 'pages/:pageId/versions'])
  async getVersions(@Param('pageId') pageId: string) {
    return this.versionService.getVersions(pageId);
  }

  @Post(['project/:projectId/pages/:pageId/versions', 'pages/:pageId/versions'])
  @HttpCode(HttpStatus.CREATED)
  async createVersion(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateVersionDto,
  ) {
    return this.versionService.createVersion(pageId, userId, dto);
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
    return this.versionService.restoreVersion(pageId, versionId);
  }

  @Delete([
    'project/:projectId/pages/:pageId/versions/:versionId',
    'pages/:pageId/versions/:versionId',
  ])
  async deleteVersion(@Param('versionId') versionId: string) {
    return this.versionService.deleteVersion(versionId);
  }

  @Get(['project/:projectId/pages/:pageId/history', 'pages/:pageId/history'])
  async getHistory(@Param('pageId') pageId: string) {
    return this.versionService.getHistory(pageId);
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
    return this.versionService.restoreVersion(pageId, eventId);
  }
}
