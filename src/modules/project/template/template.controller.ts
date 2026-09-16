import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { TemplateService } from './template.service';
import { CreateProjectTemplateDto } from './dto/create-template.dto';
import { InstantiateProjectTemplateDto } from './dto/instantiate-template.dto';

@ApiTags('Project Templates')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('api/v1/project-templates')
export class TemplateController {
  constructor(private readonly templateService: TemplateService) {}

  @Get()
  @ApiOperation({ summary: 'List accessible project templates (owned + public)' })
  listTemplates(@CurrentUser('id') userId: string) {
    return this.templateService.listTemplates(userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a project template by ID' })
  getTemplate(@Param('id') id: string) {
    return this.templateService.getTemplateById(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new project template' })
  createTemplate(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateProjectTemplateDto,
  ) {
    return this.templateService.createTemplate(userId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a project template (Creator only)' })
  updateTemplate(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: Partial<CreateProjectTemplateDto>,
  ) {
    return this.templateService.updateTemplate(id, userId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a project template (Creator only)' })
  deleteTemplate(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.templateService.deleteTemplate(id, userId);
  }

  @Post(':id/instantiate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Spawn and initialize a new project from a project template',
  })
  instantiateTemplate(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: InstantiateProjectTemplateDto,
  ) {
    return this.templateService.instantiate(id, userId, dto);
  }
}
