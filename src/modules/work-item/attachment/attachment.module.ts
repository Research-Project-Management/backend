import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core/database/prisma.module';
import { R2Service } from '@/modules/storage/r2/r2.service';
import { AttachmentController } from './attachment.controller';
import { AttachmentService } from './attachment.service';
import { AttachmentRepository } from './attachment.repository';

@Module({
  imports: [PrismaModule],
  controllers: [AttachmentController],
  providers: [R2Service, AttachmentService, AttachmentRepository],
  exports: [AttachmentService, AttachmentRepository],
})
export class AttachmentModule {}
