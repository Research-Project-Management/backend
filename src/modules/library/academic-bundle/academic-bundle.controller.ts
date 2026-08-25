import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AcademicBundleService } from './academic-bundle.service';
import { JwtAuthGuard } from '@/modules/iam/authn';
import {
  WorkspaceRoleGuard,
  WorkspaceRoles,
} from '@/modules/iam/authz';

@ApiTags('Library - Unified Facade')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class AcademicBundleController {
  constructor(private readonly academicBundleService: AcademicBundleService) {}

  @Get([
    'workspace/:workspaceId/library/items/:itemId/bundle',
    'library/:workspaceId/catalog/:itemId/bundle',
  ])
  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRoles('owner', 'admin', 'member', 'viewer')
  @ApiOperation({
    summary:
      'Deep Facade: Get unified academic bundle for a catalog item (Metadata, CSL APA/IEEE, PDF Annotations, Related Items) in a single call',
  })
  async getItemAcademicBundle(
    @Param('workspaceId') workspaceId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.academicBundleService.getItemAcademicBundle(
      workspaceId,
      itemId,
    );
  }
}
