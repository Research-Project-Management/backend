import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import {
  NoProjectContext,
  RequireOperator,
  OperatorGuard,
} from '@/modules/project/access';
import { AuthenticatedRequest } from '@/core';
import { TemplatesService } from './templates.service';
import {
  QueryTemplatesDto,
  SearchTemplatesDto,
  InstantiateTemplateDto,
  OverleafInstantiateTemplateDto,
  CreateTemplateDto,
} from './dto/template.dto';

@ApiTags('Manuscripts - Templates')
@Controller([
  'api/v1/manuscripts/templates',
  'v1/manuscripts/templates',
  'manuscripts/templates',
  'templates',
])
@NoProjectContext()
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  private extractUserId(req?: AuthenticatedRequest): string {
    const userId = req?.user?.id || req?.user?.sub || req?.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return userId;
  }

  @Get()
  @NoProjectContext()
  @ApiOperation({ summary: 'List available manuscript starter templates' })
  @ApiResponse({ status: 200, description: 'Paginated list of templates' })
  async listTemplates(@Query() query: QueryTemplatesDto) {
    return this.templatesService.listTemplates(query);
  }

  @Get('search')
  @NoProjectContext()
  @ApiOperation({ summary: 'Search manuscript templates by keyword or tag' })
  @ApiResponse({ status: 200, description: 'Search results' })
  async searchTemplates(@Query() query: SearchTemplatesDto) {
    return this.templatesService.searchTemplates(query);
  }

  @Get(':id')
  @NoProjectContext()
  @ApiOperation({ summary: 'Get details and files of a manuscript template' })
  @ApiResponse({ status: 200, description: 'Template detail' })
  async getTemplate(@Param('id') id: string) {
    return this.templatesService.getTemplate(id);
  }

  @Post('instantiate')
  @UseGuards(JwtAuthGuard)
  @NoProjectContext()
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new project instantiated from a template',
  })
  @ApiResponse({
    status: 201,
    description: 'Project successfully created from template',
  })
  async instantiateTemplate(
    @Req() req: AuthenticatedRequest,
    @Body() dto: InstantiateTemplateDto,
  ) {
    const userId = this.extractUserId(req);
    return this.templatesService.instantiateTemplate(userId, dto);
  }

  @Post('custom')
  @UseGuards(JwtAuthGuard, OperatorGuard)
  @RequireOperator()
  @NoProjectContext()
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Publish or create a custom manuscript template' })
  @ApiResponse({ status: 201, description: 'Custom template created' })
  async createCustomTemplate(@Body() dto: CreateTemplateDto) {
    return this.templatesService.createCustomTemplate(dto);
  }
}

@ApiTags('Manuscripts - Overleaf Parity')
@ApiBearerAuth('JWT-auth')
@Controller([
  'project',
  'projects',
  'api/project',
  'api/projects',
  'api/v1/manuscripts/project',
  'v1/manuscripts/project',
])
@UseGuards(JwtAuthGuard)
@NoProjectContext()
export class OverleafTemplatesParityController {
  constructor(private readonly templatesService: TemplatesService) {}

  private extractUserId(req?: AuthenticatedRequest): string {
    const userId = req?.user?.id || req?.user?.sub || req?.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return userId;
  }

  @Post('new/template')
  @NoProjectContext()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Overleaf 1:1 API Parity: Instantiate project from template',
  })
  @ApiResponse({
    status: 201,
    description: 'Created project object with project_id',
  })
  async instantiateOverleaf(
    @Req() req: AuthenticatedRequest,
    @Body() dto: OverleafInstantiateTemplateDto,
  ) {
    const userId = this.extractUserId(req);
    const templateId = dto.template_id || dto.templateVersionId || '';
    const projectName = dto.project_name || dto.projectName;

    const result = await this.templatesService.instantiateTemplate(userId, {
      templateId,
      projectName,
    });

    return {
      project_id: result.projectId,
      project: {
        _id: result.projectId,
        name: result.projectName,
        owner_ref: result.ownerId,
        rootDoc_id: result.mainFile,
        compiler: result.compiler,
        fromTemplateId: result.fromTemplateId,
        fromTemplateVersionId: result.fromTemplateVersionId,
        files: result.files,
      },
    };
  }
}
