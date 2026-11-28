/**
 * git-bridge/git-bridge.module.ts
 * NestJS Module for Flux Git Smart-HTTP Bridge.
 */

import { Module, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { PrismaModule } from '@/core';
import { IdentityModule } from '@/modules/identity/identity.module';
import { AccessModule } from '@/modules/project/access';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';
import { FilestoreModule } from '@/modules/pages/filestore/filestore.module';
import { StructureModule } from '@/modules/pages/structure/structure.module';
import { HistoryModule } from '@/modules/pages/history/history.module';
import { PackAdapter } from './adapters/pack.adapter';
import { RepoAdapter } from './adapters/repo.adapter';
import { ProtocolController } from './controllers/protocol.controller';
import { TokenController } from './controllers/token.controller';
import { GitBridgeRepository } from './git-bridge.repository';
import { MaintenanceService } from './services/maintenance.service';
import { SyncService } from './services/sync.service';
import { TokenService } from './services/token.service';

const STREAM_TYPES = [
  'application/x-git-upload-pack-request',
  'application/x-git-receive-pack-request',
];

const LFS_JSON_TYPE = 'application/vnd.git-lfs+json';

@Module({
  imports: [
    PrismaModule,
    IdentityModule,
    AccessModule,
    DocstoreModule,
    FilestoreModule,
    StructureModule,
    HistoryModule,
  ],
  controllers: [ProtocolController, TokenController],
  providers: [
    RepoAdapter,
    PackAdapter,
    GitBridgeRepository,
    TokenService,
    SyncService,
    MaintenanceService,
  ],
  exports: [
    TokenService,
    SyncService,
    MaintenanceService,
    GitBridgeRepository,
    RepoAdapter,
    PackAdapter,
  ],
})
export class GitBridgeModule implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  public onModuleInit(): void {
    const app = this.adapterHost.httpAdapter?.getInstance<FastifyInstance>();
    if (!app?.addContentTypeParser) return;

    for (const type of STREAM_TYPES) {
      if (app.hasContentTypeParser?.(type)) continue;
      app.addContentTypeParser(type, (_req, payload, done) =>
        done(null, payload),
      );
    }

    if (!app.hasContentTypeParser?.(LFS_JSON_TYPE)) {
      app.addContentTypeParser(
        LFS_JSON_TYPE,
        { parseAs: 'string' },
        (_req, body, done) => {
          try {
            done(null, body ? JSON.parse(String(body)) : {});
          } catch {
            done(null, {});
          }
        },
      );
    }
  }
}
