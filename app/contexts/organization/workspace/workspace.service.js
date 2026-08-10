import { getCache, setCache, deleteCache, deleteCacheByPattern, userWorkspacesCacheKey, CACHE_DURATION } from "../../../config/cache.js";
import { AppError } from "../../../lib/AppError.js";
import { eventBus, Events } from "../../../lib/eventBus.js";

export class WorkspaceService {
  constructor({ workspaceRepository }) {
    this.repo = workspaceRepository;
  }



  _emitMembersChanged(action, workspace, affectedUserId, actorId) {
    const workspaceId = workspace._id.toString();
    eventBus.emit(Events.WORKSPACE_MEMBERS_CHANGED, { workspaceId, payload: { action, workspace, workspaceId, workspaceUrl: workspace.url, affectedUserId, actorId } });
    eventBus.emit(Events.USER_WORKSPACES_CHANGED, { affectedUserId, payload: { action, workspaceId, workspaceUrl: workspace.url } });
  }

  async _syncCaches(workspace, affectedUserIds = []) {
    const workspaceId = workspace._id.toString();
    const allUserIds = Array.from(new Set([...(workspace.members || []).map((m) => m.userId).filter(Boolean), ...affectedUserIds]));
    await Promise.allSettled([...allUserIds.map((uid) => deleteCache(userWorkspacesCacheKey(uid))), deleteCache(`ws:${workspaceId}`), ...(workspace.url ? [deleteCache(`ws:${workspace.url}`)] : []), deleteCacheByPattern(`workspace:${workspaceId}*`)]);
  }

  async getMyWorkspaces(userId, pagination = null) {
    const cacheKey = userWorkspacesCacheKey(userId);
    const cached = await getCache(cacheKey);
    let workspaces = cached;
    let isCached = true;
    if (!cached) {
      workspaces = await this.repo.findByMember(userId);
      await setCache(cacheKey, workspaces, CACHE_DURATION.MEDIUM);
      isCached = false;
    }
    if (pagination) {
      const { skip, limit } = pagination;
      return { workspaces: workspaces.slice(skip, skip + limit), total: workspaces.length, cached: isCached };
    }
    return { workspaces, total: workspaces.length, cached: isCached };
  }

  async createWorkspace(data, userId) {
    const { name, url, color, avatar, companySize } = data;
    const workspace = await this.repo.create({ name, url, color, avatar: avatar || "", companySize: companySize || "", members: [], createdById: userId });
    workspace.members.push({ userId: userId, role: "owner" });
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
    if (!workspace.members.find((m) => m.userId.toString() === userId.toString())) throw new AppError("Not a member", 403);
    await this.repo.deleteById(workspaceId);
    await this._syncCaches(workspace);
  }

  async addMember(workspaceId, data, actorId) {
    const { userId, role, roleId } = data;
    const workspace = await this.repo.findByIdPopulated(workspaceId);
    if (!workspace) throw new AppError("Workspace not found", 404);
    if (workspace.members.find((m) => m.userId.toString() === userId.toString())) throw new AppError("User is already a member", 400);
    const resolvedRole = (role || roleId || "member").toLowerCase();
    workspace.members.push({ userId: userId, role: resolvedRole });
    await workspace.save();
    const updated = await this.repo.findByIdPopulated(workspaceId);
    await this._syncCaches(updated, [userId]);
    this._emitMembersChanged("member_added", updated, userId, actorId);
    return updated;
  }

  async updateMember(workspaceId, userId, data, actorId) {
    const { role, roleId, newRole } = data;
    const workspace = await this.repo.findById(workspaceId);
    const member = workspace.members.find((m) => m.userId.toString() === userId.toString());
    if (!member) throw new AppError("Member not found", 404);
    const resolvedRole = (role || roleId || newRole || "member").toLowerCase();
    member.role = resolvedRole;
    await workspace.save();
    const updated = await this.repo.findByIdPopulated(workspaceId);
    await this._syncCaches(updated, [userId]);
    this._emitMembersChanged("member_updated", updated, userId, actorId);
    return updated;
  }

  async removeMember(workspace, userId, actorId) {
    const ws = await this.repo.findById(workspace._id);
    ws.members = ws.members.filter((m) => m.userId.toString() !== userId.toString());
    await ws.save();
    const updated = await this.repo.findByIdPopulated(ws._id);
    await this._syncCaches(updated, [userId]);
    this._emitMembersChanged("member_removed", updated, userId, actorId);
  }

  inviteMember(workspace, body, actorId) { return this.addMember(workspace._id, body, actorId); }

  async joinWorkspace(inviteCode, userId) {
    const workspace = await this.repo.findByInviteCode(inviteCode);
    if (!workspace) throw new AppError("Invalid invite code", 400);
    if (workspace.members.find((m) => m.userId.toString() === userId.toString())) throw new AppError("Already a member", 400);
    const memberRole = await this.roleService.getRoleByName(workspace._id.toString(), "Member");
    if (!memberRole) throw new AppError("Default Member role not found", 500);
    workspace.members.push({ userId: userId, roleId: memberRole._id });
    await workspace.save();
    await this._syncCaches(workspace, [userId]);
    return workspace;
  }

  async leaveWorkspace(workspace, userId) {
    const ws = await this.repo.findById(workspace._id);
    ws.members = ws.members.filter((m) => m.userId.toString() !== userId.toString());
    await ws.save();
    await this._syncCaches(ws, [userId]);
  }


}





