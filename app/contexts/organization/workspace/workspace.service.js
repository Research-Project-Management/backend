import { getCache, setCache, deleteCache, deleteCacheByPattern, userWorkspacesCacheKey, CACHE_DURATION } from "../../../config/cache.js";
import { getIO } from "../../../config/socket.js";
import { AppError } from "../../../lib/AppError.js";

export class WorkspaceService {
  constructor({ workspaceRepository, roleService, projectRepository, pageRepository, fileRepository, taskRepository, stickyRepository }) {
    this.repo = workspaceRepository;
    this.roleService = roleService;
    this.projectRepository = projectRepository;
    this.pageRepository = pageRepository;
    this.fileRepository = fileRepository;
    this.taskRepository = taskRepository;
    this.stickyRepository = stickyRepository;
  }

  async searchWorkspace(workspaceId, query, userId, userRoleName) {
    const searchRegex = { $regex: query.trim(), $options: "i" };
    const isPrivileged = ["owner", "admin"].includes(userRoleName?.toLowerCase());

    const accessibleProjects = await this.projectRepository.findAccessibleProjectIds(workspaceId, userId, isPrivileged);

    const [projects, pages, files, stickies] = await Promise.all([
      this.projectRepository.searchProjects(accessibleProjects, query),
      this.pageRepository.searchPages(accessibleProjects, query),
      this.fileRepository.searchFiles(workspaceId, accessibleProjects, query),
      this.stickyRepository.searchStickies(workspaceId, query),
    ]);

    return [
      ...projects.map((p) => ({ type: "project", id: p._id, name: p.name, icon: p.avatar || null, updatedAt: p.updatedAt })),
      ...pages.map((p) => ({ type: "page", id: p._id, name: p.title, projectId: p.project?._id, projectName: p.project?.name, updatedAt: p.updatedAt })),
      ...files.map((f) => ({ type: f.isFolder ? "folder" : "file", id: f._id, name: f.filename, mimeType: f.mimeType, size: f.size, projectId: f.project, updatedAt: f.updatedAt })),
      ...stickies.map((s) => {
        const stripHtml = (str) => str?.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim() || "";
        return { type: "sticky", id: s._id, name: stripHtml(s.title) || "Untitled", content: stripHtml(s.content)?.substring(0, 80) || "", color: s.color, updatedAt: s.updatedAt };
      }),
    ];
  }

  _emitMembersChanged(action, workspace, affectedUserId, actorId) {
    const workspaceId = workspace._id.toString();
    getIO()?.to(`workspace:${workspaceId}`).emit("workspace:members-changed", { action, workspace, workspaceId, workspaceUrl: workspace.url, affectedUserId, actorId });
    getIO()?.to(`user:${affectedUserId}`).emit("user:workspaces-changed", { action, workspaceId, workspaceUrl: workspace.url });
  }

  async _syncCaches(workspace, affectedUserIds = []) {
    const workspaceId = workspace._id.toString();
    const allUserIds = Array.from(new Set([...(workspace.members || []).map((m) => m.user?._id?.toString() || m.user?.toString()).filter(Boolean), ...affectedUserIds]));
    await Promise.allSettled([...allUserIds.map((uid) => deleteCache(userWorkspacesCacheKey(uid))), deleteCache(`ws:${workspaceId}`), ...(workspace.url ? [deleteCache(`ws:${workspace.url}`)] : []), deleteCacheByPattern(`workspace:${workspaceId}*`)]);
  }

  async getMyWorkspaces(userId) {
    const cacheKey = userWorkspacesCacheKey(userId);
    const cached = await getCache(cacheKey);
    if (cached) return { workspaces: cached, cached: true };
    const workspaces = await this.repo.findByMember(userId);
    await setCache(cacheKey, workspaces, CACHE_DURATION.MEDIUM);
    return { workspaces, cached: false };
  }

  async createWorkspace(data, userId) {
    const { name, url, color, avatar, companySize } = data;
    const workspace = await this.repo.create({ name, url, color, avatar: avatar || "", companySize: companySize || "", members: [], createdBy: userId });
    const roleIds = await this.roleService.initializeDefaultRoles(workspace._id, userId);
    workspace.members.push({ user: userId, role: roleIds.owner });
    await workspace.save();
    await deleteCache(userWorkspacesCacheKey(userId));
    return workspace;
  }

  getWorkspace(workspaceId) { return this.repo.findByIdPopulated(workspaceId); }

  async updateWorkspace(currentWorkspace, { name, avatar, companySize }) {
    const workspace = await this.repo.updateById(currentWorkspace._id, { name, ...(avatar !== undefined && { avatar }), ...(companySize !== undefined && { companySize }) });
    await this._syncCaches(workspace);
    return workspace;
  }

  async deleteWorkspace(workspaceId, userId) {
    const workspace = await this.repo.findById(workspaceId);
    if (!workspace) throw new AppError("Workspace not found", 404);
    if (!workspace.members.find((m) => m.user.toString() === userId.toString())) throw new AppError("Not a member", 403);
    await this.repo.deleteById(workspaceId);
    await this._syncCaches(workspace);
  }

  async _resolveRole(workspaceId, roleInput) {
    if (!roleInput) {
      const defaultRole = await this.roleService.getRoleByName(workspaceId, "Member");
      return defaultRole?._id;
    }
    if (/^[0-9a-fA-F]{24}$/.test(roleInput)) {
      return roleInput;
    }
    const resolvedRole = await this.roleService.getRoleByName(workspaceId, roleInput);
    if (!resolvedRole) {
      const roles = await this.roleService.getRoles(workspaceId);
      const matched = roles.find(r => r.name.toLowerCase() === roleInput.toLowerCase());
      if (matched) return matched._id;
      throw new AppError(`Role "${roleInput}" not found in this workspace`, 404);
    }
    return resolvedRole._id;
  }

  async addMember(workspaceId, data, actorId) {
    const { userId, role, roleId } = data;
    const workspace = await this.repo.findByIdPopulated(workspaceId);
    if (!workspace) throw new AppError("Workspace not found", 404);
    if (workspace.members.find((m) => m.user._id.toString() === userId)) throw new AppError("User is already a member", 400);
    const resolvedRole = await this._resolveRole(workspaceId, roleId || role);
    workspace.members.push({ user: userId, role: resolvedRole });
    await workspace.save();
    const updated = await this.repo.findByIdPopulated(workspaceId);
    await this._syncCaches(updated, [userId]);
    this._emitMembersChanged("member_added", updated, userId, actorId);
    return updated;
  }

  async updateMember(workspaceId, userId, data, actorId) {
    const { role, roleId, newRole } = data;
    const workspace = await this.repo.findById(workspaceId);
    const member = workspace.members.find((m) => m.user.toString() === userId);
    if (!member) throw new AppError("Member not found", 404);
    const resolvedRole = await this._resolveRole(workspaceId, roleId || role || newRole);
    member.role = resolvedRole;
    await workspace.save();
    const updated = await this.repo.findByIdPopulated(workspaceId);
    await this._syncCaches(updated, [userId]);
    this._emitMembersChanged("member_updated", updated, userId, actorId);
    return updated;
  }

  async removeMember(workspace, userId, actorId) {
    const ws = await this.repo.findById(workspace._id);
    ws.members = ws.members.filter((m) => m.user.toString() !== userId);
    await ws.save();
    const updated = await this.repo.findByIdPopulated(ws._id);
    await this._syncCaches(updated, [userId]);
    this._emitMembersChanged("member_removed", updated, userId, actorId);
  }

  inviteMember(workspace, body, actorId) { return this.addMember(workspace._id, body, actorId); }

  async joinWorkspace(inviteCode, userId) {
    const workspace = await this.repo.findByInviteCode(inviteCode);
    if (!workspace) throw new AppError("Invalid invite code", 400);
    if (workspace.members.find((m) => m.user.toString() === userId.toString())) throw new AppError("Already a member", 400);
    const memberRole = await this.roleService.getRoleByName(workspace._id, "Member");
    if (!memberRole) throw new AppError("Default Member role not found", 500);
    workspace.members.push({ user: userId, role: memberRole._id });
    await workspace.save();
    await this._syncCaches(workspace, [userId]);
    return workspace;
  }

  async leaveWorkspace(workspace, userId) {
    const ws = await this.repo.findById(workspace._id);
    ws.members = ws.members.filter((m) => m.user.toString() !== userId.toString());
    await ws.save();
    await this._syncCaches(ws, [userId]);
  }

  async getRecentItems(workspaceId, userId) {
    const projects = await this.projectRepository.findByWorkspace(workspaceId);
    const projectIds = projects.map(p => p._id);

    const recentProjects = projects.map(p => ({
      type: "project",
      id: p._id.toString(),
      name: p.name,
      icon: "Folder",
      lastEdited: p.updatedAt,
      author: p.createdBy
    }));

    const pages = await this.pageRepository.findRecentPages(projectIds, 10);
    const recentPages = pages.map(p => ({
      type: "page",
      id: p._id.toString(),
      name: p.title,
      icon: "FileText",
      lastEdited: p.updatedAt,
      author: p.author
    }));

    const files = await this.fileRepository.findRecentFiles(workspaceId, 10);
    const recentFiles = files.map(f => ({
      type: "file",
      id: f._id.toString(),
      name: f.filename,
      icon: "File",
      lastEdited: f.updatedAt,
      author: f.author
    }));

    const all = [...recentProjects, ...recentPages, ...recentFiles]
      .sort((a, b) => new Date(b.lastEdited).getTime() - new Date(a.lastEdited).getTime())
      .slice(0, 10);

    return all;
  }

  async getActivityFeed(workspaceId) {
    const projects = await this.projectRepository.findByWorkspace(workspaceId);
    const projectIds = projects.map(p => p._id);

    const pages = await this.pageRepository.findRecentPages(projectIds, 10);
    const pageActivities = pages.map(p => ({
      type: "page_update",
      user: p.author,
      content: `updated document "${p.title}"`,
      time: p.updatedAt,
      itemId: p._id.toString(),
      project: p.project ? { _id: p.project._id, name: "" } : undefined
    }));

    const files = await this.fileRepository.findRecentFiles(workspaceId, 10);
    const fileActivities = files.map(f => ({
      type: "file_upload",
      user: f.author,
      content: `uploaded file "${f.filename}"`,
      time: f.createdAt,
      itemId: f._id.toString(),
      project: f.project ? { _id: f.project._id, name: "" } : undefined
    }));

    const tasks = await this.taskRepository.findRecentTasks(projectIds, 10);
    const taskActivities = tasks.map(t => ({
      type: "task_update",
      user: t.author,
      content: `updated task "${t.title}"`,
      time: t.updatedAt,
      itemId: t._id.toString(),
      project: t.project ? { _id: t.project._id, name: "" } : undefined
    }));

    const projectMap = new Map(projects.map(p => [p._id.toString(), p.name]));
    const allActivities = [...pageActivities, ...fileActivities, ...taskActivities]
      .map(act => {
        if (act.project?._id) {
          act.project.name = projectMap.get(act.project._id.toString()) || "";
        }
        return act;
      })
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      .slice(0, 15);

    return allActivities;
  }
}





