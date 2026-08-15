import { Module } from '@nestjs/common';
import { PageModule } from './page/page.module';
import { VersionModule } from './version/version.module';
import { LatexModule } from './latex/latex.module';
import { ManuscriptEngineModule } from './engine/manuscript-engine.module';

@Module({
  imports: [PageModule, VersionModule, LatexModule, ManuscriptEngineModule],
  exports: [PageModule, VersionModule, LatexModule, ManuscriptEngineModule],
})
export class ManuscriptModule {}
