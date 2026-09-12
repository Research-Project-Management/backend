import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core/database/prisma.module';
import { AttachmentModule as CoreAttachmentModule } from '@/modules/attachment/attachment.module';
import { AttachmentController } from './attachment.controller';
import { AttachmentService } from './attachment.service';

@Module({
  imports: [PrismaModule, CoreAttachmentModule],
  controllers: [AttachmentController],
  providers: [AttachmentService],
  exports: [AttachmentService],
})
export class AttachmentModule {}
