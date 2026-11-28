/**
 * git-bridge/controllers/token.controller.ts
 * JWT Management API for Editor UI (`GET /spaces/:spaceId/git`, `POST/DELETE /git/tokens`).
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { CurrentUser, JwtAuthGuard } from '@/modules/identity/auth';
import {
  CurrentAccessContext,
  type MemberAccessContext,
  NoProjectContext,
  ProjectAccessGuard,
  RequireRole,
  ResolvedSpace,
  Role,
} from '@/modules/project/access';
import {
  readPagesConfig,
  resolvePageControllerCoordinates,
} from '@/modules/pages/core';
import { TokenLimitError } from '../domain/errors';
import {
  canWrite,
  DEFAULT_BRANCH,
  GIT_USER,
  MAX_TOKENS,
  parseRepoId,
} from '../domain/policy';
import { CreateTokenDto, RepoQueryDto } from '../dto/token.dto';
import { GitBridgeRepository } from '../git-bridge.repository';
import { TokenService } from '../services/token.service';

@ApiTags('Pages - Git Bridge')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/pages')
export class TokenController {
  private readonly publicUrl?: string;

  constructor(
    private readonly repo: GitBridgeRepository,
    private readonly tokens: TokenService,
  ) {
    this.publicUrl = readPagesConfig().gitBridge.publicUrl;
  }

  private cloneUrl(req: FastifyRequest, repoId: string): string {
    const base =
      this.publicUrl ||
      `${req.headers?.['x-forwarded-proto'] || req.protocol || 'http'}://${
        req.headers?.['x-forwarded-host'] || req.headers?.host || 'localhost'
      }`;
    return `${String(base).replace(/\/+$/, '')}/git/${repoId}.git`;
  }

  @Get('spaces/:spaceId/git')
  @UseGuards(JwtAuthGuard, ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  public async getRepoInfo(
    @Param('spaceId') routeSpaceId: string,
    @Query() query: RepoQueryDto,
    @ResolvedSpace() spaceId: string | undefined,
    @CurrentAccessContext() access: MemberAccessContext | null,
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
  ) {
    const coords = resolvePageControllerCoordinates(
      { spaceId: routeSpaceId },
      spaceId,
      query?.pageId,
      req,
    );
    const effectiveSpaceId =
      coords.spaceId.trim().toLowerCase() === 'personal'
        ? userId
        : coords.spaceId;
    if (!parseRepoId(effectiveSpaceId)) {
      throw new BadRequestException('Invalid project or page identifier');
    }

    const target = await this.repo.resolveTarget(
      effectiveSpaceId,
      coords.pageId,
    );
    const effectiveRole =
      access?.role ??
      (effectiveSpaceId.toLowerCase() === userId?.toLowerCase()
        ? 'owner'
        : null);

    return {
      enabled: true,
      repoId: target.repoId,
      cloneUrl: this.cloneUrl(req, target.repoId),
      branch: DEFAULT_BRANCH,
      username: GIT_USER,
      canPush: canWrite(effectiveRole),
      maxTokens: MAX_TOKENS,
      tokens: await this.tokens.list(userId),
    };
  }

  @Post('git/tokens')
  @UseGuards(JwtAuthGuard)
  @NoProjectContext()
  @HttpCode(HttpStatus.CREATED)
  public async createToken(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateTokenDto,
  ) {
    try {
      return await this.tokens.create(userId, dto?.label);
    } catch (err: unknown) {
      if (err instanceof TokenLimitError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  @Delete('git/tokens/:tokenId')
  @UseGuards(JwtAuthGuard)
  @NoProjectContext()
  public async revokeToken(
    @CurrentUser('id') userId: string,
    @Param('tokenId') tokenId: string,
  ) {
    if (!(await this.tokens.revoke(userId, tokenId))) {
      throw new NotFoundException('Git access token not found');
    }
    return { success: true };
  }
}
