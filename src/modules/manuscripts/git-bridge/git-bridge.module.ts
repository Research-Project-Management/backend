/**
 * git-bridge/git-bridge.module.ts
 * Git Smart-HTTP bridge: exposes each manuscript project as a Git repository.
 */

import { Module, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { PrismaModule } from '@/core';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { FilestoreModule } from '@/modules/manuscripts/filestore/filestore.module';
import { StructureModule } from '@/modules/manuscripts/structure/structure.module';
import { GitBridgeController } from './git-bridge.controller';
import { GitBridgeService } from './git-bridge.service';
import { GitBridgeRepository, GitCliAdapter } from './git-bridge.repository';
import { GIT_ACCESS_REPOSITORY_PORT, GIT_CLI_PORT } from './domain';

import type { FastifyInstance } from 'fastify';

const GIT_CONTENT_TYPES = [
  'application/x-git-upload-pack-request',
  'application/x-git-receive-pack-request',
];

@Module({
  imports: [PrismaModule, DocstoreModule, FilestoreModule, StructureModule],
  controllers: [GitBridgeController],
  providers: [
    GitCliAdapter,
    GitBridgeRepository,
    GitBridgeService,
    {
      provide: GIT_CLI_PORT,
      useExisting: GitBridgeRepository,
    },
    {
      provide: GIT_ACCESS_REPOSITORY_PORT,
      useExisting: GitBridgeRepository,
    },
  ],
  exports: [
    GitBridgeService,
    GitBridgeRepository,
    GIT_CLI_PORT,
    GIT_ACCESS_REPOSITORY_PORT,
  ],
})
export class GitBridgeModule implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  /**
   * Git pack bodies are binary and can exceed the JSON body limit: register a
   * pass-through parser so the handler receives the raw request stream.
   */
  onModuleInit(): void {
    const instance =
      this.adapterHost.httpAdapter?.getInstance<FastifyInstance>();
    if (!instance?.addContentTypeParser) return;
    for (const type of GIT_CONTENT_TYPES) {
      if (instance.hasContentTypeParser?.(type)) continue;
      instance.addContentTypeParser(type, (_req, payload, done) =>
        done(null, payload),
      );
    }
  }
}
