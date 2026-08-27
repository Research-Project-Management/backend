import { Module } from '@nestjs/common';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { NotesRepository } from './notes.repository';
import { CoreModule } from '../../../core/core.module';
import { SyncCoreContextModule } from '../sync-core/sync-core.module';

@Module({
  imports: [CoreModule, SyncCoreContextModule],
  controllers: [NotesController],
  providers: [NotesRepository, NotesService],
  exports: [NotesRepository, NotesService],
})
export class NotesContextModule {}
