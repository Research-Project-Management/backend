import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AssetService } from './asset.service';
import { UploadAssetDto } from './dto/asset.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Document - Asset')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class AssetController {
  constructor(private readonly assetService: AssetService) {}

  @Post('projects/:projectId/assets')
  @HttpCode(HttpStatus.CREATED)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({
    summary:
      'Upload an image, figure, dataset or custom class/style asset to the document project',
  })
  async uploadAsset(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UploadAssetDto,
  ) {
    return this.assetService.uploadAsset(projectId, userId, dto);
  }

  @Get('projects/:projectId/assets')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary: 'List all binary figures and assets in the document project',
  })
  async getProjectAssets(@Param('projectId') projectId: string) {
    return this.assetService.getProjectAssets(projectId);
  }

  @Get(['assets/:assetId', 'projects/:projectId/assets/:assetId'])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get binary data and metadata of a specific asset' })
  async getAsset(
    @Param('assetId') assetId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.assetService.getAsset(assetId, userId);
  }

  @Delete(['assets/:assetId', 'projects/:projectId/assets/:assetId'])
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a document asset' })
  async deleteAsset(
    @Param('assetId') assetId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.assetService.deleteAsset(assetId, userId);
  }
}
