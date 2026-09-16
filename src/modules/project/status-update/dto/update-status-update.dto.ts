import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectUpdateStatus } from '@prisma/client';

export class UpdateProjectStatusUpdateDto {
  @ApiPropertyOptional({
    enum: ProjectUpdateStatus,
    description: 'Trạng thái sức khỏe dự án: on_track, at_risk, off_track',
    example: 'on_track',
  })
  @IsEnum(ProjectUpdateStatus)
  @IsOptional()
  status?: ProjectUpdateStatus;

  @ApiPropertyOptional({
    description: 'Nội dung tóm tắt cập nhật tiến độ, blockers hoặc ghi chú',
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  message?: string;
}
