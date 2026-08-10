import { clearProjectCache } from "../../../middleware/project.middleware.js";
import { AppError } from "../../../lib/AppError.js";
import { eventBus, Events } from "../../../lib/eventBus.js";

export class ProjectService {
  constructor({ projectRepository }) {
    this.projectRepository = projectRepository;
  }

  getProjects(workspaceId, userId, workspaceRole, pagination = null) {
    const isPrivileged = workspaceRole === "owner" || workspaceRole === "admin";
    const query = { workspaceId: workspaceId };
    if (!isPrivileged) query["members.userId"] = userId;
    
    return this.projectRepository.findProjectsWithCount(query, pagination);
  }

  async createProject(workspaceId, data, userId) {
    const { name, description, color, avatar, modules } = data;

    return this.projectRepository.create({
      name,
      description,
      color,
      avatar,
      modules,
      workspaceId: workspaceId,
      createdById: userId,
      members: [{ userId: userId, role: "owner" }],
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

  async addMember(projectId, data, actorId) {
    const { userId, role, roleId } = data;
    const project = await this.projectRepository.findById(projectId);
    if (!project) throw new AppError("Project not found", 404);
    if (project.members.find((m) => m.userId.toString() === userId.toString())) throw new AppError("User is already a member", 400);
    const resolvedRole = (role || roleId || "member").toLowerCase();
    project.members.push({ userId: userId, role: resolvedRole });
    await project.save();
    await clearProjectCache(projectId);
    return project;
  }

  async updateMember(projectId, userId, data, actorId) {
    const { role, roleId, newRole } = data;
    const project = await this.projectRepository.findById(projectId);
    const member = project.members.find((m) => m.userId.toString() === userId.toString());
    if (!member) throw new AppError("Member not found", 404);
    const resolvedRole = (role || roleId || newRole || "member").toLowerCase();
    member.role = resolvedRole;
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





