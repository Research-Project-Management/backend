import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ResolveQueryDto {
  @ApiProperty({
    description:
      'Academic query string (DOI, arXiv ID, arXiv URL, DOI URL, or Title)',
    example: '1706.03762',
  })
  @IsString()
  @IsNotEmpty()
  query!: string;
}

export class ResolveDoiDto {
  @ApiProperty({
    description: 'DOI identifier (e.g. 10.1038/s41586-020-2649-2 or full URL)',
    example: '10.1038/s41586-020-2649-2',
  })
  @IsString()
  @IsNotEmpty()
  doi!: string;
}
