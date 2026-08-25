import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { LibraryService } from './library.service';
import { JwtAuthGuard } from '@/modules/iam/authentication';
import {
  WorkspaceRoleGuard,
  WorkspaceRoles,
} from '@/modules/iam/authorization';

@ApiTags('Library - Unified Facade')
@ApiBearerAuth('JWT-auth')
@Controller('api/library')
@UseGuards(JwtAuthGuard)
export class LibraryController {
  constructor(private readonly libraryService: LibraryService) {}

  @Get(':workspaceId/catalog/:itemId/bundle')
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary:
      'Deep Facade: Get unified academic bundle for a catalog item (Metadata, CSL APA/IEEE, PDF Annotations, Related Items) in a single call',
  })
  async getCatalogItemAcademicBundle(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.libraryService.getCatalogItemAcademicBundle(
      workspaceId,
      itemId,
    );
  }
}
