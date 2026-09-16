import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { LinkController } from './link.controller';
import { LinkService } from './link.service';
import { LinkRepository } from './link.repository';

@Module({
  controllers: [LinkController],
  providers: [LinkService, LinkRepository, PrismaClient],
  exports: [LinkService, LinkRepository],
})
export class LinkModule {}
