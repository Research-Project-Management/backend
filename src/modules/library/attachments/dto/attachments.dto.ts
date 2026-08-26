import { IsNotEmpty, IsString, IsUrl } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export {
  CreateAnnotationDto,
  UpdateAnnotationDto,
} from '../../annotations/dto/annotations.dto';

export { CreateNoteDto, UpdateNoteDto } from '../../notes/dto/notes.dto';

export class ExtractPdfMetadataDto {
  @ApiProperty({ description: 'PDF file URL to extract metadata from' })
  @IsString()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @IsNotEmpty()
  fileUrl!: string;
}
