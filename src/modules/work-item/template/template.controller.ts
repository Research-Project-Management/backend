import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';
import { TemplateService } from './template.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { QueryTemplateDto } from './dto/query-template.dto';
import { InstantiateTemplateDto } from './dto/instantiate-template.dto';

@ApiTags('work-items')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/work-items/projects/:projectId/templates',
  'api/work-items/projects/:projectId/templates',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class TemplateController {
  constructor(private readonly templateService: TemplateService) {}

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new work item template for a project' })
  @ApiParam({ name: 'projectId', description: 'Project UUID or identifier' })
  async createTemplate(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() createTemplateDto: CreateTemplateDto,
  ) {
    return this.templateService.createTemplate(
      projectId,
      userId,
      createTemplateDto,
    );
  }

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List all work item templates for a project' })
  @ApiParam({ name: 'projectId', description: 'Project UUID or identifier' })
  async getProjectTemplates(
    @Param('projectId') projectId: string,
    @Query() queryTemplateDto: QueryTemplateDto,
  ) {
    return this.templateService.getProjectTemplates(
      projectId,
      queryTemplateDto,
    );
  }

  @Get(':templateId')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get details of a work item template' })
  @ApiParam({ name: 'projectId', description: 'Project UUID or identifier' })
  @ApiParam({ name: 'templateId', description: 'Template UUID' })
  async getTemplateById(
    @Param('projectId') projectId: string,
    @Param('templateId') templateId: string,
  ) {
    return this.templateService.getTemplateById(projectId, templateId);
  }

  @Put(':templateId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update an existing work item template' })
  @ApiParam({ name: 'projectId', description: 'Project UUID or identifier' })
  @ApiParam({ name: 'templateId', description: 'Template UUID' })
  async updateTemplate(
    @Param('projectId') projectId: string,
    @Param('templateId') templateId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() updateTemplateDto: UpdateTemplateDto,
  ) {
    const isOwner =
      req?.role === 'owner' ||
      req?.role === 'coordinator' ||
      user?.role === 'owner' ||
      user?.role === 'coordinator';
    return this.templateService.updateTemplate(
      projectId,
      templateId,
      userId,
      updateTemplateDto,
      isOwner,
    );
  }

  @Delete(':templateId')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Soft-delete a work item template' })
  @ApiParam({ name: 'projectId', description: 'Project UUID or identifier' })
  @ApiParam({ name: 'templateId', description: 'Template UUID' })
  async deleteTemplate(
    @Param('projectId') projectId: string,
    @Param('templateId') templateId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser() user: any,
    @Req() req: any,
  ) {
    const isOwner =
      req?.role === 'owner' ||
      req?.role === 'coordinator' ||
      user?.role === 'owner' ||
      user?.role === 'coordinator';
    return this.templateService.deleteTemplate(
      projectId,
      templateId,
      userId,
      isOwner,
    );
  }

  @Post(':templateId/instantiate')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create a new active work item from template (cấp mã FLUX-123 & áp dụng thuộc tính)',
  })
  @ApiParam({ name: 'projectId', description: 'Project UUID or identifier' })
  @ApiParam({ name: 'templateId', description: 'Template UUID' })
  async instantiateTemplate(
    @Param('projectId') projectId: string,
    @Param('templateId') templateId: string,
    @CurrentUser('id') userId: string,
    @Body() instantiateTemplateDto: InstantiateTemplateDto,
  ) {
    return this.templateService.instantiateTemplate(
      projectId,
      templateId,
      userId,
      instantiateTemplateDto,
    );
  }
}
