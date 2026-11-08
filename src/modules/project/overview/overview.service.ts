import { Injectable, NotFoundException } from '@nestjs/common';
import { OverviewRepository } from './overview.repository';
import { ProjectOverviewResponseDto } from './dto/project-overview-response.dto';
import { assembleProjectOverviewResponse } from './domain/overview.domain';

@Injectable()
export class OverviewService {
  constructor(private readonly overviewRepo: OverviewRepository) {}

  async getProjectOverview(
    projectId: string,
  ): Promise<ProjectOverviewResponseDto> {
    const projectMeta = await this.overviewRepo.getProjectMetadata(projectId);
    if (!projectMeta) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }

    const [
      stateCounts,
      overdueCount,
      recentActivities,
      latestStatusUpdate,
      assets,
    ] = await Promise.all([
      this.overviewRepo.getWorkItemStateGroupCounts(projectId),
      this.overviewRepo.getOverdueCount(projectId),
      this.overviewRepo.getRecentActivities(projectId, 10),
      this.overviewRepo.getLatestStatusUpdate(projectId),
      this.overviewRepo.getProjectAssets(projectId),
    ]);

    return assembleProjectOverviewResponse({
      projectMeta,
      stateCounts,
      overdueCount,
      recentActivities,
      latestStatusUpdate,
      assets,
    });
  }
}
