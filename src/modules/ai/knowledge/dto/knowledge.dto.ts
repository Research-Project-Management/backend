import { IsArray, IsOptional, IsString } from 'class-validator';
import { FromSnake } from '../../chat/dto/query.dto';

export class GetKnowledgeBulkDto {
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  ids?: string[];

  @FromSnake('space_id')
  @IsString()
  @IsOptional()
  spaceId?: string;
}
