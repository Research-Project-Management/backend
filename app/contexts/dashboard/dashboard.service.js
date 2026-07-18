export class DashboardService {
  constructor({ projectRepository, pageRepository, fileRepository, taskRepository, stickyRepository, authRepository }) {
    this.projectRepository = projectRepository;
    this.pageRepository = pageRepository;
    this.fileRepository = fileRepository;
    this.taskRepository = taskRepository;
    this.stickyRepository = stickyRepository;
    this.authRepository = authRepository;
  }

  async globalSearch(workspaceId, query, userId, userRoleName) {
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
      ...pages.map((p) => ({ type: "page", id: p._id, name: p.title, projectId: p.projectId, projectName: p.project?.name, updatedAt: p.updatedAt })),
      ...files.map((f) => ({ type: f.isFolder ? "folder" : "file", id: f._id, name: f.filename, mimeType: f.mimeType, size: f.size, projectId: f.linkedTo?.entityType === "Project" ? f.linkedTo.entityId : null, updatedAt: f.updatedAt })),
      ...stickies.map((s) => {
        const stripHtml = (str) => str?.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim() || "";
        return { type: "sticky", id: s._id, name: stripHtml(s.title) || "Untitled", content: stripHtml(s.content)?.substring(0, 80) || "", color: s.color, updatedAt: s.updatedAt };
      }),
    ];
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
      author: p.createdById
    }));

    const projectMap = new Map(projects.map(p => [p._id.toString(), p.name]));

    const pages = await this.pageRepository.findRecentPages(projectIds, 10);
    const recentPages = pages.map(p => ({
      type: "page",
      id: p._id.toString(),
      name: p.title,
      icon: "FileText",
      lastEdited: p.updatedAt,
      author: p.authorId,
      project: p.projectId ? { _id: p.projectId, name: projectMap.get(p.projectId?.toString()) || "" } : undefined
    }));

    const files = await this.fileRepository.findRecentFiles(workspaceId, 10);
    const recentFiles = files.map(f => {
      const isProjectLinked = f.linkedTo?.entityType === "Project";
      const projectId = isProjectLinked ? f.linkedTo.entityId : null;
      return {
        type: "file",
        id: f._id.toString(),
        name: f.filename,
        icon: "File",
        lastEdited: f.updatedAt,
        author: f.authorId,
        project: projectId ? { _id: projectId, name: projectMap.get(projectId) || "" } : undefined
      };
    });

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
      user: p.authorId,
      content: `updated document "${p.title}"`,
      time: p.updatedAt,
      itemId: p._id.toString(),
      project: p.projectId ? { _id: p.projectId, name: "" } : undefined
    }));

    const files = await this.fileRepository.findRecentFiles(workspaceId, 10);
    const fileActivities = files.map(f => {
      const isProjectLinked = f.linkedTo?.entityType === "Project";
      const projectId = isProjectLinked ? f.linkedTo.entityId : null;
      return {
        type: "file_upload",
        user: f.authorId,
        content: `uploaded file "${f.filename}"`,
        time: f.createdAt,
        itemId: f._id.toString(),
        project: projectId ? { _id: projectId, name: "" } : undefined
      };
    });

    const tasks = await this.taskRepository.findRecentTasks(projectIds, 10);
    const taskActivities = tasks.map(t => ({
      type: "task_update",
      user: t.authorId,
      content: `updated task "${t.title}"`,
      time: t.updatedAt,
      itemId: t._id.toString(),
      project: t.projectId ? { _id: t.projectId, name: "" } : undefined
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

  async getProjectOverview(projectId, userId) {
    let project = await this.projectRepository.findByIdPopulated(projectId);
    if (project) {
      project = project.toObject();
      const userIds = project.members.map(m => m.userId).filter(Boolean);
      const users = await this.authRepository.model.find({ _id: { $in: userIds } }).select("name email avatar").lean();
      const userMap = new Map(users.map(u => [u._id.toString(), u]));
      
      project.members = project.members.map(m => ({
        ...m,
        user: userMap.get(m.userId?.toString()) || { _id: m.userId, name: "Unknown User", email: "", avatar: null }
      }));
    }
    
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
}
