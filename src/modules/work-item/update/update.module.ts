import { Module } from '@nestjs/common';
import { UpdateService } from './update.service';
import { UpdateController } from './update.controller';
import { PrismaModule } from '@/core/database/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [UpdateController],
  providers: [UpdateService],
  exports: [UpdateService],
})
export class UpdateModule {}

