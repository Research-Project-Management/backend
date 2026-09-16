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
import { SuggestionService } from './suggestion.service';
import { CreateSuggestionDto } from './dto/suggestion.dto';
import { SuggestionStatus } from '@prisma/client';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Document - Suggestion & Track Changes')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class SuggestionController {
  constructor(private readonly suggestionService: SuggestionService) {}

  @Get(['pages/:pageId/suggestions', 'projects/:projectId/pages/:pageId/suggestions'])
  @ProjectRoles('owner', 'contributor', 'commenter', 'viewer')
  @ApiOperation({ summary: 'List review suggestions (Track Changes) for a document page' })
  async getSuggestions(
    @Param('pageId') pageId: string,
    @Query('status') status?: SuggestionStatus,
  ) {
    const suggestions = await this.suggestionService.getSuggestions(pageId, status);
    return { suggestions };
  }

  @Post(['pages/:pageId/suggestions', 'projects/:projectId/pages/:pageId/suggestions'])
  @ProjectRoles('owner', 'contributor', 'commenter')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new proposed edit/suggestion in Track Changes mode' })
  async createSuggestion(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateSuggestionDto,
  ) {
    const suggestion = await this.suggestionService.createSuggestion(pageId, userId, dto);
    return { suggestion };
  }

  @Post([
    'pages/:pageId/suggestions/:suggestionId/accept',
    'projects/:projectId/pages/:pageId/suggestions/:suggestionId/accept',
  ])
  @ProjectRoles('owner', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a proposed edit and apply diff to document' })
  async acceptSuggestion(
    @Param('pageId') pageId: string,
    @Param('suggestionId') suggestionId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.suggestionService.acceptSuggestion(pageId, suggestionId, userId);
  }

  @Post([
    'pages/:pageId/suggestions/:suggestionId/reject',
    'projects/:projectId/pages/:pageId/suggestions/:suggestionId/reject',
  ])
  @ProjectRoles('owner', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a proposed edit without applying' })
  async rejectSuggestion(
    @Param('pageId') pageId: string,
    @Param('suggestionId') suggestionId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.suggestionService.rejectSuggestion(pageId, suggestionId, userId);
  }

  @Post([
    'pages/:pageId/suggestions/accept-all',
    'projects/:projectId/pages/:pageId/suggestions/accept-all',
  ])
  @ProjectRoles('owner', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept all pending suggestions on this document' })
  async acceptAllSuggestions(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.suggestionService.acceptAllSuggestions(pageId, userId);
  }

  @Post([
    'pages/:pageId/suggestions/reject-all',
    'projects/:projectId/pages/:pageId/suggestions/reject-all',
  ])
  @ProjectRoles('owner', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject all pending suggestions on this document' })
  async rejectAllSuggestions(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.suggestionService.rejectAllSuggestions(pageId, userId);
  }
}
