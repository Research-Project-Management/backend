/**
 * git-bridge/git-bridge.controller.ts
 *
 * Git Smart-HTTP protocol endpoints (clone/fetch/pull/push) plus JWT-protected
 * token management and repository info for the editor UI.
 *
 *   GET  /git/:projectId.git/info/refs?service=git-upload-pack|git-receive-pack
 *   POST /git/:projectId.git/git-upload-pack
 *   POST /git/:projectId.git/git-receive-pack
 *
 * Authentication: HTTP Basic, password = personal Git token (username ignored).
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { createGunzip } from 'zlib';
import { Readable } from 'stream';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import {
  NoProjectContext,
  ProjectAccessGuard,
  RequireRole,
  Role,
} from '@/modules/project/access';
import { UserRateLimit, UserRateLimitGuard } from '@/core';
import { readManuscriptsConfig } from '../core/config/manuscripts.config';
import { GitBridgeService } from './git-bridge.service';
import { CreateGitTokenDto } from './dto/git-bridge.dto';
import {
  canRead,
  canWrite,
  GIT_DEFAULT_BRANCH,
  GIT_SERVICES,
  GitService,
  parseRepoName,
} from './domain/git-bridge.types';

function pktLine(s: string): Buffer {
  const len = (Buffer.byteLength(s) + 4).toString(16).padStart(4, '0');
  return Buffer.from(len + s);
}

@ApiTags('Manuscripts - Git Bridge')
@Controller()
export class GitBridgeController {
  private readonly logger = new Logger(GitBridgeController.name);

  constructor(private readonly gitBridgeService: GitBridgeService) {}

  // ─── Smart HTTP ──────────────────────────────────────────────────────────────

  private unauthorized(
    reply: FastifyReply,
    message = 'Authentication required',
  ) {
    reply.raw.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Flux Git", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    reply.raw.end(`${message}\n`);
  }

  private fail(reply: FastifyReply, status: number, message: string) {
    if (reply.raw.headersSent) {
      reply.raw.end();
      return;
    }
    reply.raw.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    reply.raw.end(`${message}\n`);
  }

  /** Authenticates and authorizes; writes the error response and returns null on failure. */
  private async authorize(
    req: FastifyRequest,
    reply: FastifyReply,
    repo: string,
    service: GitService,
  ): Promise<string | null> {
    const projectId = parseRepoName(repo);
    if (!projectId) {
      this.fail(reply, 404, 'Repository not found');
      return null;
    }
    const userId = await this.gitBridgeService.authenticate(
      req.headers?.authorization,
    );
    if (!userId) {
      this.unauthorized(reply, 'Invalid or missing Git token');
      return null;
    }
    const role = await this.gitBridgeService.resolveRole(projectId, userId);
    if (!canRead(role)) {
      this.fail(reply, 404, 'Repository not found');
      return null;
    }
    if (service === 'git-receive-pack' && !canWrite(role)) {
      this.fail(reply, 403, 'You have read-only access to this project');
      return null;
    }
    return projectId;
  }

  @Get('git/:repo/info/refs')
  @UseGuards(UserRateLimitGuard)
  @NoProjectContext()
  @UserRateLimit('git')
  @ApiExcludeEndpoint()
  async infoRefs(
    @Param('repo') repo: string,
    @Query('service') service: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    if (!GIT_SERVICES.has(service)) {
      return this.fail(reply, 403, 'Dumb HTTP protocol is not supported');
    }
    const svc = service as GitService;
    const projectId = await this.authorize(req, reply, repo, svc);
    if (!projectId) return;
    try {
      const refs = await this.gitBridgeService.withProjectLock(
        projectId,
        async () => {
          await this.gitBridgeService.materialize(projectId);
          return this.gitBridgeService.advertiseRefs(projectId, svc);
        },
      );
      reply.raw.writeHead(200, {
        'Content-Type': `application/x-${svc}-advertisement`,
        'Cache-Control': 'no-cache, max-age=0, must-revalidate',
        Pragma: 'no-cache',
      });
      reply.raw.write(pktLine(`# service=${svc}\n`));
      reply.raw.write('0000');
      reply.raw.end(refs);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`info/refs failed for ${projectId}: ${msg}`);
      this.fail(reply, 500, 'Failed to prepare repository');
    }
  }

  private requestBody(req: FastifyRequest): Readable {
    const raw: Readable =
      req.body && typeof (req.body as Readable).pipe === 'function'
        ? (req.body as Readable)
        : req.raw;
    const enc = String(req.headers?.['content-encoding'] || '').toLowerCase();
    return enc === 'gzip' || enc === 'x-gzip' ? raw.pipe(createGunzip()) : raw;
  }

  @Post('git/:repo/git-upload-pack')
  @UseGuards(UserRateLimitGuard)
  @NoProjectContext()
  @UserRateLimit('git')
  @ApiExcludeEndpoint()
  async uploadPack(
    @Param('repo') repo: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const projectId = await this.authorize(req, reply, repo, 'git-upload-pack');
    if (!projectId) return;
    try {
      const result = await this.gitBridgeService.withProjectLock(
        projectId,
        async () => {
          await this.gitBridgeService.materialize(projectId);
          return this.gitBridgeService.serviceRpc(
            projectId,
            'git-upload-pack',
            this.requestBody(req),
          );
        },
      );
      if (result.code !== 0 && result.stdout.length === 0) {
        throw new BadRequestException(result.stderr || `exit ${result.code}`);
      }
      reply.raw.writeHead(200, {
        'Content-Type': 'application/x-git-upload-pack-result',
        'Cache-Control': 'no-cache',
      });
      reply.raw.end(result.stdout);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`upload-pack failed for ${projectId}: ${msg}`);
      this.fail(reply, 500, 'git-upload-pack failed');
    }
  }

  @Post('git/:repo/git-receive-pack')
  @UseGuards(UserRateLimitGuard)
  @NoProjectContext()
  @UserRateLimit('git')
  @ApiExcludeEndpoint()
  async receivePack(
    @Param('repo') repo: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const projectId = await this.authorize(
      req,
      reply,
      repo,
      'git-receive-pack',
    );
    if (!projectId) return;
    try {
      const outcome = await this.gitBridgeService.handleReceivePack(
        projectId,
        this.requestBody(req),
      );

      if ('rejected' in outcome) {
        return this.fail(reply, 403, outcome.rejected);
      }
      reply.raw.writeHead(200, {
        'Content-Type': 'application/x-git-receive-pack-result',
        'Cache-Control': 'no-cache',
      });
      reply.raw.end(outcome.stdout);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`receive-pack failed for ${projectId}: ${msg}`);
      this.fail(reply, 500, `Push could not be applied: ${msg}`);
    }
  }

  // ─── Management API (JWT) ───────────────────────────────────────────────────

  private cloneUrl(req: FastifyRequest, projectId: string): string {
    const { gitBridge } = readManuscriptsConfig();
    const base =
      gitBridge.publicUrl ||
      `${req.headers?.['x-forwarded-proto'] || req.protocol || 'http'}://${
        req.headers?.['x-forwarded-host'] || req.headers?.host
      }`;
    return `${String(base).replace(/\/+$/, '')}/git/${projectId}.git`;
  }

  @Get('api/v1/manuscripts/projects/:projectId/git')
  @UseGuards(JwtAuthGuard, ProjectAccessGuard)
  @RequireRole(Role.REVIEWER)
  @ApiBearerAuth('JWT-auth')
  async repoInfo(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Req() req: FastifyRequest,
  ) {
    if (!parseRepoName(projectId))
      throw new BadRequestException('Invalid project id');
    const role = await this.gitBridgeService.resolveRole(projectId, userId);
    if (!canRead(role)) throw new NotFoundException('Project not found');
    return {
      enabled: true,
      cloneUrl: this.cloneUrl(req, projectId),
      branch: GIT_DEFAULT_BRANCH,
      canPush: canWrite(role),
      tokens: await this.gitBridgeService.listTokens(userId),
    };
  }

  @Get('api/v1/manuscripts/git/tokens')
  @UseGuards(JwtAuthGuard)
  @NoProjectContext()
  @ApiBearerAuth('JWT-auth')
  async listTokens(@CurrentUser('id') userId: string) {
    return { tokens: await this.gitBridgeService.listTokens(userId) };
  }

  @Post('api/v1/manuscripts/git/tokens')
  @UseGuards(JwtAuthGuard)
  @NoProjectContext()
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.CREATED)
  async createToken(
    @CurrentUser('id') userId: string,
    @Body() body: CreateGitTokenDto,
  ) {
    try {
      const created = await this.gitBridgeService.createToken(
        userId,
        body?.label,
      );
      return { ...created, token: created.token };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create token';
      throw new ForbiddenException(msg);
    }
  }

  @Delete('api/v1/manuscripts/git/tokens/:tokenId')
  @UseGuards(JwtAuthGuard)
  @NoProjectContext()
  @ApiBearerAuth('JWT-auth')
  async revokeToken(
    @CurrentUser('id') userId: string,
    @Param('tokenId') tokenId: string,
  ) {
    const revoked = await this.gitBridgeService.revokeToken(userId, tokenId);
    if (!revoked) throw new NotFoundException('Token not found');
    return { success: true };
  }
}
