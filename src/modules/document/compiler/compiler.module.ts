import { Module } from '@nestjs/common';
import { CompilerController } from './compiler.controller';
import { CompilerService } from './compiler.service';
import { PageModule } from '../page/page.module';
import { HistoryModule } from '../history/history.module';
import { AssetModule } from '../asset/asset.module';
import { CoreModule as AppCoreModule } from '@/core/core.module';
import { CollaborationModule } from '../collaboration/collaboration.module';

@Module({
  imports: [
    PageModule,
    HistoryModule,
    AssetModule,
    AppCoreModule,
    CollaborationModule,
  ],
  controllers: [CompilerController],
  providers: [CompilerService],
  exports: [CompilerService],
})
export class CompilerModule {}

export const LatexModule = CompilerModule;
export type LatexModule = CompilerModule;
export const EngineModule = CompilerModule;
export type EngineModule = CompilerModule;
export const SynctexModule = CompilerModule;
export type SynctexModule = CompilerModule;
