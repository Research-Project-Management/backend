import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LibraryService } from './library.service';
import { LibraryFacade, LIBRARY_FACADE } from './library.facade';
import { SsrfGuardService } from './services/ssrf-guard.service';
import { ItemsModule } from '../items/items.module';

@Module({
  imports: [ConfigModule, forwardRef(() => ItemsModule)],
  controllers: [],
  providers: [
    LibraryService,
    LibraryFacade,
    {
      provide: LIBRARY_FACADE,
      useClass: LibraryFacade,
    },
    SsrfGuardService,
  ],
  exports: [LibraryService, LibraryFacade, LIBRARY_FACADE, SsrfGuardService],
})
export class CoreModule {}
