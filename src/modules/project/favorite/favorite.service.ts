import { Injectable, NotFoundException } from '@nestjs/common';
import { FavoriteRepository } from './favorite.repository';

@Injectable()
export class FavoriteService {
  constructor(private readonly favoriteRepo: FavoriteRepository) {}

  async getUserFavoriteProjectIds(userId: string): Promise<string[]> {
    return this.favoriteRepo.findUserFavorites(userId);
  }

  async isProjectFavorite(projectId: string, userId: string): Promise<boolean> {
    return this.favoriteRepo.isFavorite(projectId, userId);
  }

  async addFavorite(
    projectId: string,
    userId: string,
  ): Promise<{ isFavorite: boolean }> {
    const exists = await this.favoriteRepo.projectExists(projectId);
    if (!exists) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    await this.favoriteRepo.addFavorite(projectId, userId);
    return { isFavorite: true };
  }

  async removeFavorite(
    projectId: string,
    userId: string,
  ): Promise<{ isFavorite: boolean }> {
    await this.favoriteRepo.removeFavorite(projectId, userId);
    return { isFavorite: false };
  }

  async toggleFavorite(
    projectId: string,
    userId: string,
  ): Promise<{ isFavorite: boolean }> {
    const isFav = await this.favoriteRepo.isFavorite(projectId, userId);
    if (isFav) {
      await this.favoriteRepo.removeFavorite(projectId, userId);
      return { isFavorite: false };
    } else {
      const exists = await this.favoriteRepo.projectExists(projectId);
      if (!exists) {
        throw new NotFoundException(`Project with ID "${projectId}" not found`);
      }
      await this.favoriteRepo.addFavorite(projectId, userId);
      return { isFavorite: true };
    }
  }

  async batchCheckFavorites(
    projectIds: string[],
    userId: string,
  ): Promise<Set<string>> {
    return this.favoriteRepo.batchCheckFavorites(projectIds, userId);
  }
}
