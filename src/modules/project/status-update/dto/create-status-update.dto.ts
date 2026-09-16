import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ProjectUpdateStatus } from '@prisma/client';

export class CreateProjectStatusUpdateDto {
  @ApiProperty({
    enum: ProjectUpdateStatus,
    description: 'Trạng thái sức khỏe dự án: on_track, at_risk, off_track',
    example: 'on_track',
  })
  @IsEnum(ProjectUpdateStatus)
  @IsNotEmpty()
  status!: ProjectUpdateStatus;

  @ApiProperty({
    description: 'Nội dung tóm tắt cập nhật tiến độ, blockers hoặc ghi chú',
    example: 'Sprint 2 đã hoàn thành 80%, frontend và backend kết nối mượt mà.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message!: string;
}
