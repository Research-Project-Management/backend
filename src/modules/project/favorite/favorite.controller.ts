import {
  Controller,
  Post,
  Delete,
  Get,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import { FavoriteService } from './favorite.service';

@ApiTags('Project Favorites')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller(['api/v1/projects', 'api/projects'])
export class FavoriteController {
  constructor(private readonly favoriteService: FavoriteService) {}

  @Get('favorites/ids')
  @ApiOperation({
    summary: 'Get list of project IDs favorited by current user',
  })
  getUserFavorites(@CurrentUser('id') userId: string) {
    return this.favoriteService.getUserFavoriteProjectIds(userId);
  }

  @Post(':projectId/favorite')
  @ApiOperation({ summary: 'Mark project as favorite for current user' })
  @ApiResponse({ status: 200, description: 'Project marked as favorite' })
  addFavorite(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.favoriteService.addFavorite(projectId, userId);
  }

  @Delete(':projectId/favorite')
  @ApiOperation({ summary: 'Remove project from favorites for current user' })
  @ApiResponse({ status: 200, description: 'Project removed from favorites' })
  removeFavorite(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.favoriteService.removeFavorite(projectId, userId);
  }

  @Post(':projectId/favorite/toggle')
  @ApiOperation({ summary: 'Toggle favorite status for a project' })
  toggleFavorite(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.favoriteService.toggleFavorite(projectId, userId);
  }
}
