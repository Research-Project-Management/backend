import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ReferenceService } from './reference.service';
import {
  ResolveDoiDto,
  CreateReferenceDto,
  ExportBibtexDto,
} from './dto/reference.dto';
import { JwtAuthGuard } from '@/modules/iam/authentication';
import { CurrentUser } from '@/modules/iam/authentication';

@ApiTags('Library - References')
@ApiBearerAuth('JWT-auth')
@Controller('api/library/references')
@UseGuards(JwtAuthGuard)
export class ReferenceController {
  constructor(private readonly referenceService: ReferenceService) {}

  @Post('resolve-doi')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve academic metadata from a DOI string via CrossRef',
  })
  async resolveDoiPost(@Body() dto: ResolveDoiDto) {
    return this.referenceService.resolveDoi(dto.doi);
  }

  @Get('doi/:doi')
  @ApiOperation({ summary: 'Lookup academic metadata from a DOI' })
  async resolveDoiParam(@Param('doi') doi: string) {
    return this.referenceService.resolveDoi(doi);
  }

  @Post(':workspaceId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create an academic reference item in a workspace (without requiring PDF)',
  })
  async createReference(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateReferenceDto,
  ) {
    return this.referenceService.createReference(workspaceId, userId, dto);
  }

  @Get(':workspaceId/bibtex')
  @ApiOperation({
    summary: 'Export workspace or collection references to BibTeX format',
  })
  async exportWorkspaceBibtex(
    @Param('workspaceId') workspaceId: string,
    @Query() query: ExportBibtexDto,
  ) {
    return this.referenceService.exportWorkspaceBibtex(
      workspaceId,
      query.collectionId,
    );
  }
}
