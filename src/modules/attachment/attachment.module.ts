import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core/database/prisma.module';
import { R2Service } from '@/modules/storage/r2/r2.service';
import { AttachmentController } from './attachment.controller';
import { AttachmentRepository } from './attachment.repository';
import { AttachmentService } from './attachment.service';

@Module({
  imports: [PrismaModule],
  controllers: [AttachmentController],
  providers: [R2Service, AttachmentRepository, AttachmentService],
  exports: [AttachmentService, AttachmentRepository],
})
export class AttachmentModule {}
