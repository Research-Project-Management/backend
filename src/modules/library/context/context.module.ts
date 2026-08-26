import { Module } from '@nestjs/common';
import { ContextController } from './context.controller';
import { ContextService } from './context.service';
import { ItemsModule } from '../items/items.module';
import { CiteModule } from '../cite/cite.module';
import { RelationsModule } from '../relations/relations.module';

@Module({
  imports: [ItemsModule, CiteModule, RelationsModule],
  controllers: [ContextController],
  providers: [ContextService],
  exports: [ContextService],
})
export class ContextModule {}
