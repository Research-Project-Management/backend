/**
 * templates/templates.controller.ts
 * Canonical REST API for Pages Templates & Gallery:
 * - GET    /api/v1/pages/templates                                         (Virtual Proxy summary list)
 * - GET    /api/v1/pages/templates/:id                                     (Full template detail + files)
 * - POST   /api/v1/pages/templates                                         (Publish Personal or Project template from a Page)
 * - PATCH  /api/v1/pages/templates/:id                                     (Update Space template metadata)
 * - DELETE /api/v1/pages/templates/:id                                     (Delete Space template)
 * - POST   /api/v1/pages/spaces/:spaceId/templates/:templateId/instantiate (Instantiate a new Page from a template)
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
import { resolvePageControllerCoordinates } from '@/modules/pages/core';
import {
  InstantiateTemplateDto,
  PublishTemplateDto,
  QueryTemplatesDto,
  UpdateTemplateDto,
} from './dto/template.dto';
import { GalleryService } from './services/gallery.service';
import { InstantiateService } from './services/instantiate.service';
import { PublishService } from './services/publish.service';

@ApiTags('Pages - Templates')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('api/v1/pages')
export class TemplatesController {
  constructor(
    private readonly gallery: GalleryService,
    private readonly publisher: PublishService,
    private readonly instantiator: InstantiateService,
  ) {}

  @Get('templates')
  @NoProjectContext()
  @ApiOperation({ summary: 'Browse and search page template summaries' })
  public browse(
    @CurrentUser('id') userId: string,
    @Query() query: QueryTemplatesDto,
  ) {
    return this.gallery.browse(userId, query);
  }

  @Get('templates/:id')
  @NoProjectContext()
  @ApiOperation({ summary: 'Retrieve full template manifest and files' })
  public getDetail(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    return this.gallery.getDetail(id, userId, spaceId);
  }

  @Post('templates')
  @UseGuards(UserRateLimitGuard)
  @NoProjectContext()
  @UserRateLimit('import')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Publish a page as an immutable template' })
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
  @ApiOperation({ summary: 'Update custom template catalog metadata' })
  public update(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.gallery.update(id, userId, dto);
  }

  @Delete('templates/:id')
  @NoProjectContext()
  @ApiOperation({ summary: 'Delete a personal or project template' })
  public async remove(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    await this.gallery.remove(id, userId);
    return { success: true };
  }

  @Post('spaces/:spaceId/templates/:templateId/instantiate')
  @UseGuards(ProjectAccessGuard, UserRateLimitGuard)
  @RequireRole(Role.CONTRIBUTOR)
  @UserRateLimit('import')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Instantiate a new Page from a template' })
  public instantiate(
    @Param('spaceId') routeSpaceId: string,
    @Param('templateId') templateId: string,
    @CurrentUser('id') userId: string,
    @Body() body?: InstantiateTemplateDto,
    @ResolvedSpace() authorizedSpace?: string | { id?: string },
    @Req() req?: FastifyRequest,
  ) {
    const { spaceId } = resolvePageControllerCoordinates(
      { spaceId: routeSpaceId },
      authorizedSpace,
      undefined,
      req,
    );
    return this.instantiator.instantiate(spaceId, templateId, userId, body);
  }
}
