import { clearProjectCache } from "../../../middleware/project.middleware.js";
import { AppError } from "../../../lib/AppError.js";
import { eventBus, Events } from "../../../lib/eventBus.js";

export class ProjectService {
  constructor({ projectRepository, roleRepository, roleService }) {
    this.projectRepository = projectRepository;
    this.roleRepository = roleRepository;
    this.roleService = roleService;
  }

  getProjects(workspaceId, userId, workspaceRole, pagination = null) {
    const isPrivileged = workspaceRole === "owner" || workspaceRole === "admin";
    const query = { workspaceId: workspaceId };
    if (!isPrivileged) query["members.userId"] = userId;
    
    return this.projectRepository.findProjectsWithCount(query, pagination);
  }

  async createProject(workspaceId, data, userId) {
    const { name, description, color, avatar, modules } = data;
    let ownerRole = await this.roleRepository.findByWorkspaceAndName(workspaceId, "Owner");
    
    // For backward compatibility with old workspaces that don't have roles
    if (!ownerRole) {
      const roles = await this.roleService.initializeDefaultRoles(workspaceId, userId);
      ownerRole = await this.roleRepository.findById(roles.owner);
    }

    const roleId = ownerRole ? ownerRole._id : null;

    return this.projectRepository.create({
      name,
      description,
      color,
      avatar,
      modules,
      workspaceId: workspaceId,
      createdById: userId,
      members: [{ userId: userId, roleId: roleId }],
      taskColumns: [
        { id: "todo", title: "Todo", accentColor: "#6b7280" },
        { id: "in-progress", title: "In Progress", accentColor: "#3b82f6" },
        { id: "done", title: "Done", accentColor: "#10b981" }
      ],
      taskSequence: 0
    });
  }



  async updateProject(currentProject, updates, userId) {
    const project = await this.projectRepository.updateById(currentProject._id, updates);
    await clearProjectCache(currentProject._id);
    eventBus.emit(Events.PROJECT_UPDATED, { workspaceId: currentProject.workspaceId.toString(), projectId: currentProject._id.toString() });
    return project;
  }

  async deleteProject(projectId, userId) { await this.projectRepository.deleteById(projectId); await clearProjectCache(projectId); }

  async _resolveRole(workspaceId, roleInput) {
    if (!roleInput) {
      const defaultRole = await this.roleRepository.findByWorkspaceAndName(workspaceId, "Member");
      return defaultRole?._id;
    }
    if (/^[0-9a-fA-F]{24}$/.test(roleInput)) {
      return roleInput;
    }
    const resolvedRole = await this.roleRepository.findByWorkspaceAndName(workspaceId, roleInput);
    if (!resolvedRole) {
      const roles = await this.roleRepository.findByWorkspace(workspaceId);
      const matched = roles.find(r => r.name.toLowerCase() === roleInput.toLowerCase());
      if (matched) return matched._id;
      throw new AppError(`Role "${roleInput}" not found in this workspace`, 404);
    }
    return resolvedRole._id;
  }

  async addMember(projectId, data, actorId) {
    const { userId, role, roleId } = data;
    const project = await this.projectRepository.findById(projectId);
    if (!project) throw new AppError("Project not found", 404);
    if (project.members.find((m) => m.userId.toString() === userId.toString())) throw new AppError("User is already a member", 400);
    const resolvedRole = await this._resolveRole(project.workspaceId, roleId || role);
    project.members.push({ userId: userId, roleId: resolvedRole });
    await project.save();
    await clearProjectCache(projectId);
    return project;
  }

  async updateMember(projectId, userId, data, actorId) {
    const { role, roleId, newRole } = data;
    const project = await this.projectRepository.findById(projectId);
    const member = project.members.find((m) => m.userId.toString() === userId.toString());
    if (!member) throw new AppError("Member not found", 404);
    const resolvedRole = await this._resolveRole(project.workspaceId, roleId || role || newRole);
    member.roleId = resolvedRole;
    await project.save();
    await clearProjectCache(projectId);
    return project;
  }

  async removeMember(currentProject, userId, actorId) {
    const project = await this.projectRepository.findById(currentProject._id);
    project.members = project.members.filter((m) => m.userId.toString() !== userId.toString());
    await project.save();
    await clearProjectCache(currentProject._id);
  }

  async addColumn(projectId, { title, color }, userId) {
    const project = await this.projectRepository.findById(projectId);
    if (!project) throw new AppError("Project not found", 404);
    project.taskColumns.push({ id: `col_${Date.now()}`, title: title, accentColor: color || "#e2e8f0" });
    await project.save();
    await clearProjectCache(projectId);
    eventBus.emit(Events.PROJECT_COLUMN_CREATED, { projectId: projectId.toString(), columns: project.taskColumns });
    return project;
  }

  async updateColumn(projectId, columnId, { title, color }, userId) {
    const project = await this.projectRepository.findById(projectId);
    const col = project.taskColumns.find((c) => c.id === columnId || c._id?.toString() === columnId);
    if (!col) throw new AppError("Column not found", 404);
    if (title !== undefined) col.title = title;
    if (color !== undefined) col.accentColor = color;
    await project.save();
    await clearProjectCache(projectId);
    eventBus.emit(Events.PROJECT_COLUMN_UPDATED, { projectId: projectId.toString(), columns: project.taskColumns });
    return project;
  }

  async deleteColumn(projectId, columnId, userId) {
    const project = await this.projectRepository.findById(projectId);
    const colIndex = project.taskColumns.findIndex((c) => c.id === columnId || c._id?.toString() === columnId);
    if (colIndex === -1) throw new AppError("Column not found", 404);
    project.taskColumns.splice(colIndex, 1);
    await project.save();
    await clearProjectCache(projectId);
    eventBus.emit(Events.PROJECT_COLUMN_UPDATED, { projectId: projectId.toString(), columns: project.taskColumns });
    return project;
  }
}





