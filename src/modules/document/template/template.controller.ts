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
import { TemplateService } from './template.service';
import { ApplyTemplateDto, SaveAsTemplateDto } from './dto/template.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Document - Templates')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class TemplateController {
  constructor(private readonly templateService: TemplateService) {}

  @Get('document-templates')
  @ApiOperation({
    summary:
      'List all available document templates (IEEE, ACM, Springer, Thesis)',
  })
  async getTemplates(@Query('category') category?: string) {
    return this.templateService.getTemplates(category);
  }

  @Get('document-templates/:id')
  @ApiOperation({ summary: 'Get details of a document template' })
  async getTemplateById(@Param('id') id: string) {
    return this.templateService.getTemplateById(id);
  }

  @Post([
    'projects/:projectId/templates/:templateId/apply',
    'project/:projectId/templates/:templateId/apply',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Apply a template to create a new manuscript in the project',
  })
  async applyTemplate(
    @Param('projectId') projectId: string,
    @Param('templateId') templateId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ApplyTemplateDto,
  ) {
    return this.templateService.applyTemplateToProject(
      templateId,
      projectId,
      userId,
      dto,
    );
  }

  @Post([
    'projects/:projectId/pages/:pageId/save-as-template',
    'project/:projectId/pages/:pageId/save-as-template',
    'pages/:pageId/save-as-template',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'contributor')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Save an existing document as a custom lab/team template',
  })
  async saveAsTemplate(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: SaveAsTemplateDto,
  ) {
    return this.templateService.savePageAsTemplate(pageId, userId, dto);
  }
}
