import { Module } from '@nestjs/common';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { NotesRepository } from './notes.repository';
import { CoreModule } from '../../../core/core.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ItemsModule } from '../items/items.module';
import { ITEM_NOTES_EXTRACTOR_PORT } from '../items/ports/items.ports';

@Module({
  imports: [CoreModule, OutboxModule, ItemsModule],
  controllers: [NotesController],
  providers: [
    NotesRepository,
    NotesService,
    {
      provide: ITEM_NOTES_EXTRACTOR_PORT,
      useExisting: NotesService,
    },
  ],
  exports: [NotesService, ITEM_NOTES_EXTRACTOR_PORT],
})
export class NotesModule {}
