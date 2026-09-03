import {
  IsString,
  IsOptional,
  MaxLength,
  ValidateIf,
  IsUUID,
} from 'class-validator';

export class UpdateCollectionDto {
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  color?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @ValidateIf(
    (o) =>
      o.parentId !== null &&
      o.parentId !== undefined &&
      o.parentId !== '' &&
      o.parentId !== 'root',
  )
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  parent?: string | null;
}
