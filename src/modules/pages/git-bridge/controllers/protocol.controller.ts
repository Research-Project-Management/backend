/**
 * git-bridge/controllers/protocol.controller.ts
 * Git Smart-HTTP Wire Protocol (`/git/:repo/*`) & Git LFS 422 Rejection Controller.
 */

import {
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { UserRateLimit, UserRateLimitGuard } from '@/core';
import { NoProjectContext } from '@/modules/project/access';
import {
  canRead,
  canWrite,
  GIT_SERVICES,
  GitService,
  parseRepoId,
} from '../domain/policy';
import { PktReportBuilder } from '../domain/pack.domain';
import { GitBridgeRepository } from '../git-bridge.repository';
import { SyncService } from '../services/sync.service';
import { TokenService } from '../services/token.service';

interface GitSession {
  readonly repoId: string;
  readonly userId: string;
}

@ApiExcludeController()
@Controller('git/:repo')
export class ProtocolController {
  private readonly logger = new Logger(ProtocolController.name);

  constructor(
    private readonly repo: GitBridgeRepository,
    private readonly tokens: TokenService,
    private readonly sync: SyncService,
  ) {}

  private sendAuthChallenge(reply: FastifyReply, msg: string): void {
    reply.raw.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Flux Git", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    reply.raw.end(`${msg}\n`);
  }

  private sendError(reply: FastifyReply, status: number, msg: string): void {
    if (reply.raw.headersSent) {
      reply.raw.end();
      return;
    }
    reply.raw.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    reply.raw.end(`${msg}\n`);
  }

  private bodyStream(req: FastifyRequest): Readable {
    const raw: Readable =
      req.body && typeof (req.body as Readable).pipe === 'function'
        ? (req.body as Readable)
        : req.raw;
    const enc = String(req.headers?.['content-encoding'] || '').toLowerCase();
    return enc === 'gzip' || enc === 'x-gzip' ? raw.pipe(createGunzip()) : raw;
  }

  private async authorize(
    req: FastifyRequest,
    reply: FastifyReply,
    repoParam: string,
    service: GitService,
  ): Promise<GitSession | null> {
    const repoId = parseRepoId(repoParam);
    if (!repoId) {
      this.sendError(reply, 404, 'Repository not found');
      return null;
    }

    const userId = await this.tokens.authenticate(req.headers?.authorization);
    if (!userId) {
      this.sendAuthChallenge(reply, 'Invalid, expired, or missing Git token');
      return null;
    }

    const role = await this.repo.resolveRole(repoId, userId);
    if (!canRead(role)) {
      this.sendError(reply, 404, 'Repository not found');
      return null;
    }
    if (service === 'git-receive-pack' && !canWrite(role)) {
      this.sendError(reply, 403, 'You have read-only access to this project');
      return null;
    }
    return { repoId, userId };
  }

  @Get('info/refs')
  @UseGuards(UserRateLimitGuard)
  @NoProjectContext()
  @UserRateLimit('git')
  public async infoRefs(
    @Param('repo') repo: string,
    @Query('service') service: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (!GIT_SERVICES.has(service)) {
      this.sendError(reply, 403, 'Dumb HTTP protocol is not supported');
      return;
    }
    const svc = service as GitService;
    const session = await this.authorize(req, reply, repo, svc);
    if (!session) return;

    try {
      const refs = await this.sync.advertiseRefs(session.repoId, svc);
      reply.raw.writeHead(200, {
        'Content-Type': `application/x-${svc}-advertisement`,
        'Cache-Control': 'no-cache, max-age=0, must-revalidate',
        Pragma: 'no-cache',
      });
      reply.raw.end(PktReportBuilder.advertise(svc, refs));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`info/refs failed for ${session.repoId}: ${msg}`);
      this.sendError(reply, 500, 'Failed to prepare Git repository');
    }
  }

  @Post('git-upload-pack')
  @UseGuards(UserRateLimitGuard)
  @NoProjectContext()
  @UserRateLimit('git')
  public async uploadPack(
    @Param('repo') repo: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.authorize(req, reply, repo, 'git-upload-pack');
    if (!session) return;

    try {
      await this.sync.streamUpload(
        session.repoId,
        this.bodyStream(req),
        reply.raw,
        () => {
          if (!reply.raw.headersSent) {
            reply.raw.writeHead(200, {
              'Content-Type': 'application/x-git-upload-pack-result',
              'Cache-Control': 'no-cache',
            });
          }
        },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`upload-pack failed for ${session.repoId}: ${msg}`);
      this.sendError(reply, 500, 'git-upload-pack failed');
    }
  }

  @Post('git-receive-pack')
  @UseGuards(UserRateLimitGuard)
  @NoProjectContext()
  @UserRateLimit('git')
  public async receivePack(
    @Param('repo') repo: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await this.authorize(req, reply, repo, 'git-receive-pack');
    if (!session) return;

    try {
      const res = await this.sync.receivePush(
        session.repoId,
        session.userId,
        this.bodyStream(req),
      );
      reply.raw.writeHead(200, {
        'Content-Type': 'application/x-git-receive-pack-result',
        'Cache-Control': 'no-cache',
      });
      reply.raw.end(res.stdout);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`receive-pack failed for ${session.repoId}: ${msg}`);
      this.sendError(reply, 500, `Push could not be applied: ${msg}`);
    }
  }

  @Post('info/lfs/objects/batch')
  @UseGuards(UserRateLimitGuard)
  @NoProjectContext()
  @UserRateLimit('git')
  public lfsBatch(@Res() reply: FastifyReply): void {
    reply.raw.writeHead(422, {
      'Content-Type': 'application/vnd.git-lfs+json; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    reply.raw.end(
      JSON.stringify({
        message:
          'Git LFS is not supported. Commit raw binary files (< 50 MB) without Git LFS.',
      }),
    );
  }
}
