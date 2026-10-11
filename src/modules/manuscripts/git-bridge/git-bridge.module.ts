/**
 * git-bridge/git-bridge.module.ts
 * Git Smart-HTTP bridge: exposes each manuscript project as a Git repository.
 */

import { Module, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { PrismaModule } from '@/core';
import { DocstoreModule } from '../docstore/docstore.module';
import { FilestoreModule } from '../filestore/filestore.module';
import { StructureModule } from '../structure/structure.module';
import { GitBridgeController } from './git-bridge.controller';
import { GitCliAdapter } from './core/adapters/git-cli.adapter';
import { GitAccessUseCase } from './core/use-cases/git-access.use-case';
import { GitSyncUseCase } from './core/use-cases/git-sync.use-case';

import type { FastifyInstance } from 'fastify';

const GIT_CONTENT_TYPES = [
  'application/x-git-upload-pack-request',
  'application/x-git-receive-pack-request',
];

@Module({
  imports: [PrismaModule, DocstoreModule, FilestoreModule, StructureModule],
  controllers: [GitBridgeController],
  providers: [GitCliAdapter, GitAccessUseCase, GitSyncUseCase],
  exports: [GitAccessUseCase, GitSyncUseCase],
})
export class GitBridgeModule implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  /**
   * Git pack bodies are binary and can exceed the JSON body limit: register a
   * pass-through parser so the handler receives the raw request stream.
   */
  onModuleInit(): void {
    const instance = this.adapterHost.httpAdapter?.getInstance<FastifyInstance>();
    if (!instance?.addContentTypeParser) return;
    for (const type of GIT_CONTENT_TYPES) {
      if (instance.hasContentTypeParser?.(type)) continue;
      instance.addContentTypeParser(
        type,
        (_req, payload, done) => done(null, payload),
      );
    }
  }
}
