import { asyncHandler } from "../../../lib/asyncHandler.js";

export class ProjectController {
  constructor({ projectService }) {
    this.projectService = projectService;
    this.getProjects = asyncHandler(async (req, res) => { res.json({ projects: await this.projectService.getProjects(req.params.workspaceId, req.user._id) }); });
    this.createProject = asyncHandler(async (req, res) => { res.status(201).json({ project: await this.projectService.createProject(req.params.workspaceId, req.body, req.user._id) }); });
    this.getProject = asyncHandler(async (req, res) => { res.json({ project: req.project, yourRole: req.projectRole }); });
    this.getProjectOverview = asyncHandler(async (req, res) => { res.json(await this.projectService.getProjectOverview(req.project._id, req.user._id)); });
    this.updateProject = asyncHandler(async (req, res) => { res.json({ project: await this.projectService.updateProject(req.project, req.body, req.user._id) }); });
    this.deleteProject = asyncHandler(async (req, res) => { await this.projectService.deleteProject(req.project._id, req.user._id); res.status(204).end(); });
    this.getProjectMembers = asyncHandler(async (req, res) => { res.json({ members: req.project.members }); });
    this.addProjectMember = asyncHandler(async (req, res) => { res.status(201).json({ project: await this.projectService.addMember(req.project._id, req.body, req.user._id) }); });
    this.updateProjectMember = asyncHandler(async (req, res) => { res.json({ project: await this.projectService.updateMember(req.project._id, req.params.userId || req.body.userId, req.body, req.user._id) }); });
    this.removeProjectMember = asyncHandler(async (req, res) => { await this.projectService.removeMember(req.project, req.params.userId || req.body.userId, req.user._id); res.status(204).end(); });
    this.addColumn = asyncHandler(async (req, res) => { res.status(201).json({ project: await this.projectService.addColumn(req.project._id, req.body, req.user._id) }); });
    this.updateColumn = asyncHandler(async (req, res) => { res.json({ project: await this.projectService.updateColumn(req.project._id, req.params.columnId, req.body, req.user._id) }); });
    this.deleteColumn = asyncHandler(async (req, res) => { res.json({ project: await this.projectService.deleteColumn(req.project._id, req.params.columnId, req.user._id) }); });
  }
}



