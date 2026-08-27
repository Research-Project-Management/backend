import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { DiscoveryRepository } from './discovery.repository';
import { FullTextIndexer } from './full-text-indexer';
import { DiscoveryService } from './discovery.service';
import { DiscoveryController } from './discovery.controller';

@Module({
  imports: [CoreModule],
  controllers: [DiscoveryController],
  providers: [DiscoveryRepository, FullTextIndexer, DiscoveryService],
  exports: [DiscoveryService, FullTextIndexer, DiscoveryRepository],
})
export class DiscoveryContextModule {}
