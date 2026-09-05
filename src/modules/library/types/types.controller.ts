import {
  Controller,
  Get,
  Param,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { TypesService } from './types.service';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';

@Controller('api/v1/workspaces/:workspaceId/library/item-types')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class TypesController {
  constructor(private readonly typesService: TypesService) {}

  @Get()
  listAllItemTypes() {
    return {
      success: true,
      registryVersion: this.typesService.getSchemaVersion(),
      schemaVersion: this.typesService.getSchemaVersion(),
      source: this.typesService.getSource(),
      itemTypes: this.typesService.getAllItemTypes(),
      data: this.typesService.getAllItemTypes(),
    };
  }

  @Get(':itemType')
  getItemTypeDefinition(@Param('itemType') itemType: string) {
    const definition = this.typesService.getItemType(itemType);
    if (!definition) {
      throw new NotFoundException(
        `Item type '${itemType}' not found in Library registry`,
      );
    }
    return { success: true, itemType: definition, data: definition };
  }
}

export const ItemTypesController = TypesController;
export type ItemTypesController = TypesController;
