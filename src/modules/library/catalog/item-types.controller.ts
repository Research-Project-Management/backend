import {
  Controller,
  Get,
  Param,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { ItemTypeRegistryService } from './registry/item-type-registry.service';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';

@Controller('api/v1/workspaces/:workspaceId/library/item-types')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class ItemTypesController {
  constructor(private readonly registryService: ItemTypeRegistryService) {}

  @Get()
  listAllItemTypes() {
    return {
      success: true,
      registryVersion: this.registryService.getSchemaVersion(),
      schemaVersion: this.registryService.getSchemaVersion(),
      source: this.registryService.getSource(),
      itemTypes: this.registryService.getAllItemTypes(),
      data: this.registryService.getAllItemTypes(),
    };
  }

  @Get(':itemType')
  getItemTypeDefinition(@Param('itemType') itemType: string) {
    const definition = this.registryService.getItemType(itemType);
    if (!definition) {
      throw new NotFoundException(
        `Item type '${itemType}' not found in Library registry`,
      );
    }
    return { success: true, itemType: definition, data: definition };
  }
}
