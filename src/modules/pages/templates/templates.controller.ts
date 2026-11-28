/**
 * templates/templates.controller.ts
 * Canonical REST API for Manuscripts Templates & Gallery (Overleaf parity):
 * - GET    /api/v1/pages/templates                                      (Virtual Proxy summary list)
 * - GET    /api/v1/pages/templates/:id                                  (Full template detail + files)
 * - POST   /api/v1/pages/templates                                      (Publish private/workspace/official template)
 * - PATCH  /api/v1/pages/templates/:id                                  (Update template metadata)
 * - DELETE /api/v1/pages/templates/:id                                  (Delete custom template)
 * - POST   /api/v1/pages/spaces/:spaceId/templates/:templateId/scaffold (Instantiate/scaffold onto Space or Page)
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { UserRateLimit, UserRateLimitGuard } from '@/core';
import { CurrentUser, JwtAuthGuard } from '@/modules/identity/auth';
import {
  NoProjectContext,
  ProjectAccessGuard,
  RequireRole,
  ResolvedSpace,
  Role,
} from '@/modules/project/access';
import { resolvePageControllerCoordinates } from '../core/utils/page-scope';
import {
  PublishTemplateDto,
  QueryTemplatesDto,
  ScaffoldTemplateDto,
  UpdateTemplateDto,
} from './dto/template.dto';
import { GalleryService } from './services/gallery.service';
import { PublishService } from './services/publish.service';
import { ScaffoldService } from './services/scaffold.service';

@ApiTags('Manuscripts - Templates')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('api/v1/pages')
export class TemplatesController {
  constructor(
    private readonly gallery: GalleryService,
    private readonly publisher: PublishService,
    private readonly scaffolder: ScaffoldService,
  ) {}

  @Get('templates')
  @NoProjectContext()
  @ApiOperation({ summary: 'Browse and search manuscript template summaries' })
  public browse(
    @CurrentUser('id') userId: string,
    @Query() query: QueryTemplatesDto,
  ) {
    return this.gallery.browse(userId, query);
  }

  @Get('templates/:id')
  @NoProjectContext()
  @ApiOperation({ summary: 'Retrieve full template manifest and files' })
  public getDetail(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.gallery.getDetail(id, userId);
  }

  @Post('templates')
  @UseGuards(UserRateLimitGuard)
  @NoProjectContext()
  @UserRateLimit('import')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Publish a manuscript template from a workspace or inline files',
  })
  public publish(
    @CurrentUser('id') userId: string,
    @Body() dto: PublishTemplateDto,
  ) {
    return this.publisher.publish(userId, dto);
  }

  @Patch('templates/:id')
  @UseGuards(UserRateLimitGuard)
  @NoProjectContext()
  @UserRateLimit('import')
  @ApiOperation({ summary: 'Update custom template metadata' })
  public update(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.gallery.update(id, userId, dto);
  }

  @Delete('templates/:id')
  @NoProjectContext()
  @ApiOperation({ summary: 'Delete a private or workspace template' })
  public async remove(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    await this.gallery.remove(id, userId);
    return { success: true };
  }

  @Post('spaces/:spaceId/templates/:templateId/scaffold')
  @UseGuards(ProjectAccessGuard, UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('import')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Instantiate a new Page or scaffold an existing Page from a template',
  })
  public scaffold(
    @Param('spaceId') routeSpaceId: string,
    @Param('templateId') templateId: string,
    @CurrentUser('id') userId: string,
    @Body() body?: ScaffoldTemplateDto,
    @ResolvedSpace() authorizedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    const { spaceId, pageId } = resolvePageControllerCoordinates(
      { spaceId: routeSpaceId },
      authorizedSpace,
      body?.pageId,
      req,
    );
    return this.scaffolder.scaffold(spaceId, templateId, userId, {
      pageId,
      title: body?.title,
    });
  }
}
