import { clearProjectCache } from "../../../middleware/project.middleware.js";
import { getIO } from "../../../config/socket.js";
import { AppError } from "../../../lib/AppError.js";

export class ProjectService {
  constructor({ projectRepository, fileRepository, taskRepository, roleRepository }) {
    this.projectRepository = projectRepository;
    this.fileRepository = fileRepository;
    this.taskRepository = taskRepository;
    this.roleRepository = roleRepository;
  }

  getProjects(workspaceId, userId, workspaceRole) {
    const isPrivileged = workspaceRole === "owner" || workspaceRole === "admin";
    const query = { workspace: workspaceId };
    if (!isPrivileged) query["members.user"] = userId;
    return this.projectRepository.model.find(query);
  }

  async createProject(workspaceId, data, userId) {
    const { name, description, color, avatar, modules } = data;
    const ownerRole = await this.roleRepository.findByWorkspaceAndName(workspaceId, "Owner");
    const roleId = ownerRole ? ownerRole._id : null;

    return this.projectRepository.create({
      name,
      description,
      color,
      avatar,
      modules,
      workspace: workspaceId,
      createdBy: userId,
      members: [{ user: userId, role: roleId }],
      taskColumns: [
        { id: "todo", title: "Todo", accentColor: "#6b7280" },
        { id: "in-progress", title: "In Progress", accentColor: "#3b82f6" },
        { id: "done", title: "Done", accentColor: "#10b981" }
      ],
      taskSequence: 0
    });
  }

  async getProjectOverview(projectId, userId) {
    const project = await this.projectRepository.findByIdPopulated(projectId);
    
    const files = await this.fileRepository.findAllActiveByProject(projectId);
    const fileCount = files.length;
    const totalSize = files.reduce((acc, f) => acc + (f.size || 0), 0);
    
    const tasks = await this.taskRepository.findByProject(projectId);
    const taskCount = tasks.length;
    const completedTasks = tasks.filter(t => t.completed).length;
    const inProgressTasks = tasks.filter(t => t.columnId === "in-progress" && !t.completed).length;
    const pendingTasks = taskCount - completedTasks - inProgressTasks;

    const stats = {
      files: { count: fileCount, totalSize, recent: files.slice(0, 5) },
      tasks: { total: taskCount, completed: completedTasks, pending: pendingTasks, inProgress: inProgressTasks },
      members: project.members.length
    };

    return { project, stats };
  }

  async updateProject(currentProject, updates, userId) {
    const project = await this.projectRepository.updateById(currentProject._id, updates);
    await clearProjectCache(currentProject._id);
    getIO()?.to(`workspace:${currentProject.workspace}`).emit("project:updated", { projectId: currentProject._id });
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
    if (project.members.find((m) => m.user.toString() === userId)) throw new AppError("User is already a member", 400);
    const resolvedRole = await this._resolveRole(project.workspace, roleId || role);
    project.members.push({ user: userId, role: resolvedRole });
    await project.save();
    await clearProjectCache(projectId);
    return project;
  }

  async updateMember(projectId, userId, data, actorId) {
    const { role, roleId, newRole } = data;
    const project = await this.projectRepository.findById(projectId);
    const member = project.members.find((m) => m.user.toString() === userId);
    if (!member) throw new AppError("Member not found", 404);
    const resolvedRole = await this._resolveRole(project.workspace, roleId || role || newRole);
    member.role = resolvedRole;
    await project.save();
    await clearProjectCache(projectId);
    return project;
  }

  async removeMember(currentProject, userId, actorId) {
    const project = await this.projectRepository.findById(currentProject._id);
    project.members = project.members.filter((m) => m.user.toString() !== userId);
    await project.save();
    await clearProjectCache(currentProject._id);
  }

  async addColumn(projectId, { title, color }, userId) {
    const project = await this.projectRepository.findById(projectId);
    if (!project) throw new AppError("Project not found", 404);
    project.taskColumns.push({ id: `col_${Date.now()}`, title: title, accentColor: color || "#e2e8f0" });
    await project.save();
    await clearProjectCache(projectId);
    getIO()?.to(`project:${projectId}`).emit("column:created", { columns: project.taskColumns });
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
    getIO()?.to(`project:${projectId}`).emit("column:updated", { columns: project.taskColumns });
    return project;
  }

  async deleteColumn(projectId, columnId, userId) {
    const project = await this.projectRepository.findById(projectId);
    const colIndex = project.taskColumns.findIndex((c) => c.id === columnId || c._id?.toString() === columnId);
    if (colIndex === -1) throw new AppError("Column not found", 404);
    project.taskColumns.splice(colIndex, 1);
    await project.save();
    await clearProjectCache(projectId);
    getIO()?.to(`project:${projectId}`).emit("column:updated", { columns: project.taskColumns });
    return project;
  }
}





