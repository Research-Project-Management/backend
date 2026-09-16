import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { LinkService } from './link.service';
import { CreateProjectLinkDto } from './dto/create-link.dto';
import { UpdateProjectLinkDto } from './dto/update-link.dto';

@ApiTags('Project Links')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('api/v1/projects')
export class LinkController {
  constructor(private readonly linkService: LinkService) {}

  @Get(':projectId/links')
  @ApiOperation({ summary: 'List all pinned links for a project' })
  @ApiResponse({ status: 200, description: 'List of pinned links' })
  getLinks(@Param('projectId') projectId: string) {
    return this.linkService.getLinks(projectId);
  }

  @Post(':projectId/links')
  @ApiOperation({ summary: 'Create a new pinned link for a project' })
  @ApiResponse({ status: 201, description: 'Pinned link created successfully' })
  createLink(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateProjectLinkDto,
  ) {
    return this.linkService.createLink(projectId, userId, dto);
  }

  @Patch(':projectId/links/:linkId')
  @ApiOperation({ summary: 'Update an existing pinned link' })
  @ApiResponse({ status: 200, description: 'Pinned link updated successfully' })
  updateLink(
    @Param('projectId') projectId: string,
    @Param('linkId') linkId: string,
    @Body() dto: UpdateProjectLinkDto,
  ) {
    return this.linkService.updateLink(projectId, linkId, dto);
  }

  @Delete(':projectId/links/:linkId')
  @ApiOperation({ summary: 'Delete a pinned link from a project' })
  @ApiResponse({ status: 200, description: 'Pinned link deleted successfully' })
  deleteLink(
    @Param('projectId') projectId: string,
    @Param('linkId') linkId: string,
  ) {
    return this.linkService.deleteLink(projectId, linkId);
  }
}
