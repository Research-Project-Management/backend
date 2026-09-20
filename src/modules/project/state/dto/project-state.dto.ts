import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsNumber,
  IsBoolean,
  IsArray,
  ValidateNested,
  MaxLength,
  IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
export class CreateProjectStateDto {
  @ApiProperty({
    description: 'Name of the project state',
    example: 'Khảo sát thực địa (Field Trip)',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty({ message: 'Tên trạng thái không được để trống' })
  @MaxLength(100, { message: 'Tên trạng thái tối đa 100 ký tự' })
  name!: string;

  @ApiPropertyOptional({
    description: 'Description or guidelines for this project state',
    example: 'Giai đoạn thu thập mẫu địa chất và khảo nghiệm hiện trường.',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    description: 'Badge hex or CSS color',
    example: '#0284c7',
    default: '#0284c7',
  })
  @IsString()
  @IsOptional()
  color?: string;

  @ApiPropertyOptional({
    description: 'Order sequence for drag and drop reordering',
    example: 3,
    default: 0,
  })
  @IsNumber()
  @IsOptional()
  sequence?: number;

  @ApiPropertyOptional({
    description: 'Whether this state is the initial default state for newly created projects',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

export class UpdateProjectStateItemDto {
  @ApiPropertyOptional({
    description: 'Updated state name',
    example: 'Khảo sát thực địa & Thu mẫu',
    maxLength: 100,
  })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: 'Updated description',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    description: 'Updated color code',
    example: '#8b5cf6',
  })
  @IsString()
  @IsOptional()
  color?: string;

  @ApiPropertyOptional({
    description: 'Updated sequence position',
  })
  @IsNumber()
  @IsOptional()
  sequence?: number;

  @ApiPropertyOptional({
    description: 'Set as default starting state',
  })
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

export class TransitionProjectStateDto {
  @ApiPropertyOptional({
    description: 'Target State UUID to transition project to, or null to unassign',
    example: '01957c91-2345-7890-abcd-ef0123456789',
    nullable: true,
  })
  @IsUUID('all', { message: 'ID trạng thái phải là UUID hợp lệ' })
  @IsOptional()
  stateId?: string | null;
}

export class ReorderProjectStateItemDto {
  @ApiProperty({
    description: 'State UUID',
    example: '01957c91-2345-7890-abcd-ef0123456789',
  })
  @IsUUID('all', { message: 'ID trạng thái phải là UUID hợp lệ' })
  id!: string;

  @ApiProperty({
    description: 'New sequence order position after drag & drop',
    example: 2,
  })
  @IsNumber()
  sequence!: number;
}

export class ReorderProjectStatesDto {
  @ApiProperty({
    description: 'List of state IDs with their new sequence positions',
    type: [ReorderProjectStateItemDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderProjectStateItemDto)
  states!: ReorderProjectStateItemDto[];
}

export class DeleteProjectStateDto {
  @ApiPropertyOptional({
    description:
      'Fallback state ID to migrate the project to if it is currently at the state being deleted',
    example: '01957c91-2345-7890-abcd-ef0123456789',
  })
  @IsUUID('all', { message: 'Fallback state ID phải là UUID hợp lệ' })
  @IsOptional()
  fallbackStateId?: string;
}

// Aliases for backwards compatibility during refactor
export { CreateProjectStateDto as CreateLifecycleStateDto };
export { UpdateProjectStateItemDto as UpdateLifecycleStateDto };
export { ReorderProjectStatesDto as ReorderLifecycleStatesDto };
