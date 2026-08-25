import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { MetadataService } from './metadata.service';
import { ResolveQueryDto, ResolveDoiDto } from './dto/metadata.dto';
import { JwtAuthGuard } from '@/modules/iam/authentication';

@ApiTags('Library - Metadata')
@ApiBearerAuth('JWT-auth')
@Controller('api/library/metadata')
@UseGuards(JwtAuthGuard)
export class MetadataController {
  constructor(private readonly metadataService: MetadataService) {}

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Resolve academic metadata from any query string (DOI, arXiv ID, URL, Title) across multiple providers',
  })
  async resolve(@Body() dto: ResolveQueryDto) {
    return this.metadataService.resolve(dto.query);
  }

  @Post('resolve-doi')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve academic metadata from a DOI string via CrossRef',
  })
  async resolveDoi(@Body() dto: ResolveDoiDto) {
    return this.metadataService.resolve(dto.doi);
  }

  @Get('doi/:doi')
  @ApiOperation({ summary: 'Lookup academic metadata from a DOI' })
  async resolveDoiParam(@Param('doi') doi: string) {
    return this.metadataService.resolve(doi);
  }
}
