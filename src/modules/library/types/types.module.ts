import { Module } from '@nestjs/common';
import { TypesController } from './types.controller';
import { TypesService } from './types.service';
import { ZoteroSchemaValidatorService } from './services/zotero-schema-validator.service';
import { CoreModule } from '../../../core/core.module';

@Module({
  imports: [CoreModule],
  controllers: [TypesController],
  providers: [TypesService, ZoteroSchemaValidatorService],
  exports: [TypesService, ZoteroSchemaValidatorService],
})
export class TypesModule {}
