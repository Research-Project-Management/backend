import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SynctexService } from './synctex.service';
import { ForwardSyncDto, ReverseSyncDto } from './dto/synctex.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

@ApiTags('Document - SyncTeX')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class SynctexController {
  constructor(private readonly synctexService: SynctexService) {}

  @Post([
    'synctex/forward',
    'projects/:projectId/synctex/forward',
    'compiler/synctex/forward',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Forward SyncTeX: map LaTeX source line/column to PDF page coordinates',
  })
  async forwardSync(@Body() dto: ForwardSyncDto) {
    return this.synctexService.forwardSync(dto);
  }

  @Post([
    'synctex/reverse',
    'projects/:projectId/synctex/reverse',
    'compiler/synctex/reverse',
  ])
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reverse SyncTeX: map clicked PDF page coordinates to LaTeX source line/column',
  })
  async reverseSync(@Body() dto: ReverseSyncDto) {
    return this.synctexService.reverseSync(dto);
  }
}
