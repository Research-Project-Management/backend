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
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { TemplateService } from './template.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { QueryTemplateDto } from './dto/query-template.dto';
import { InstantiateTemplateDto } from './dto/instantiate-template.dto';

@ApiTags('work-items')
@ApiBearerAuth('JWT-auth')
@Controller('api/work-items/projects/:projectId/templates')
@UseGuards(JwtAuthGuard)
export class TemplateController {
  constructor(private readonly templateService: TemplateService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new work item template for a project' })
  @ApiParam({ name: 'projectId', description: 'Project UUID or identifier' })
  async createTemplate(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() createTemplateDto: CreateTemplateDto,
  ) {
    return this.templateService.createTemplate(projectId, userId, createTemplateDto);
  }

  @Get()
  @ApiOperation({ summary: 'List all work item templates for a project' })
  @ApiParam({ name: 'projectId', description: 'Project UUID or identifier' })
  async getProjectTemplates(
    @Param('projectId') projectId: string,
    @Query() queryTemplateDto: QueryTemplateDto,
  ) {
    return this.templateService.getProjectTemplates(projectId, queryTemplateDto);
  }

  @Get(':templateId')
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
  @ApiOperation({ summary: 'Update an existing work item template' })
  @ApiParam({ name: 'projectId', description: 'Project UUID or identifier' })
  @ApiParam({ name: 'templateId', description: 'Template UUID' })
  async updateTemplate(
    @Param('projectId') projectId: string,
    @Param('templateId') templateId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser() user: any,
    @Body() updateTemplateDto: UpdateTemplateDto,
  ) {
    const isAdmin = user?.role === 'admin' || user?.role === 'owner';
    return this.templateService.updateTemplate(
      projectId,
      templateId,
      userId,
      updateTemplateDto,
      isAdmin,
    );
  }

  @Delete(':templateId')
  @ApiOperation({ summary: 'Soft-delete a work item template' })
  @ApiParam({ name: 'projectId', description: 'Project UUID or identifier' })
  @ApiParam({ name: 'templateId', description: 'Template UUID' })
  async deleteTemplate(
    @Param('projectId') projectId: string,
    @Param('templateId') templateId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser() user: any,
  ) {
    const isAdmin = user?.role === 'admin' || user?.role === 'owner';
    return this.templateService.deleteTemplate(
      projectId,
      templateId,
      userId,
      isAdmin,
    );
  }

  @Post(':templateId/instantiate')
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
