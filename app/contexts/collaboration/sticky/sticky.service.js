import { AppError } from "../../../lib/AppError.js";

export class StickyService {
  constructor({ stickyRepository }) {
    this.repo = stickyRepository;
  }

  async getStickies(scopeContext, userId, queryParams = {}) {
    const query = { ...scopeContext, userId };
    
    // Support searching
    if (queryParams.search) {
      return this.repo.searchStickies(query, queryParams.search);
    }

    // Shows all stickies within the workspace, optionally filtered by project
    if (queryParams.projectId && queryParams.projectId !== "null" && queryParams.projectId !== "undefined") {
      const projectIds = queryParams.projectId.split(',').filter(Boolean);
      if (projectIds.length > 0) {
        query.projectId = { $in: projectIds };
      }
    }
    
    return this.repo.find(query);
  }

  async createSticky(scopeContext, payload, userId) {
    const { title = "", content = "<p></p>", color = "yellow-1", position = { x: 0, y: 0 }, projectId: payloadProjectId } = payload;
    
    // projectId can come from the route (scopeContext) or the payload
    const finalProjectId = scopeContext.projectId || payloadProjectId || null;
    const isProjectSticky = Boolean(finalProjectId);
    
    return this.repo.create({ 
      title,
      content,
      color,
      position,
      userId,
      ...scopeContext,
      projectId: finalProjectId,
      scope: isProjectSticky ? "project" : "workspace", 
    });
  }

  async reorder(stickyIds, userId, scopeContext) {
    if (!Array.isArray(stickyIds)) {
      throw new AppError("stickyIds must be an array", 400);
    }
    
    // scopeContext will contain { workspaceId } or { projectId, workspaceId }
    // which serves as a secure filter scope.
    const operations = stickyIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id, userId, ...scopeContext },
        update: { $set: { order: index } }
      }
    }));
    
    if (operations.length > 0) {
      await this.repo.bulkReorder(operations);
    }
  }

  async updateSticky(stickyId, updates, userId) {
    const sticky = await this.repo.findById(stickyId);
    if (!sticky) {
      throw new AppError("Sticky not found", 404);
    }
    if (sticky.userId.toString() !== userId.toString()) {
      throw new AppError("Access denied", 403);
    }

    const { title, content, color, position, projectId } = updates;
    const updateData = Object.fromEntries(
      Object.entries({ title, content, color, position, projectId })
        .filter(([, value]) => value !== undefined)
    );

    if (updateData.projectId) {
      updateData.scope = "project";
    }
    
    return this.repo.updateById(stickyId, updateData);
  }

  async deleteSticky(stickyId, userId) {
    const sticky = await this.repo.findById(stickyId);
    if (!sticky) {
      throw new AppError("Sticky not found", 404);
    }
    if (sticky.userId.toString() !== userId.toString()) {
      throw new AppError("Access denied", 403);
    }
    
    await this.repo.deleteById(stickyId);
  }
}

export class WorkspaceStickyService extends StickyService {
  constructor({ workspaceStickyRepository }) {
    super({ stickyRepository: workspaceStickyRepository });
  }
}

export class ProjectStickyService extends StickyService {
  constructor({ projectStickyRepository }) {
    super({ stickyRepository: projectStickyRepository });
  }
}
