import { Router } from 'express';
import { isAuthenticated } from '../../../middleware/auth.middleware.js';
import { checkWorkspaceRole } from '../../../middleware/workspace.middleware.js';
import { checkProjectRole } from '../../../middleware/project.middleware.js';
import { validate } from "../../../middleware/validate.middleware.js";
import { CreateProjectDto, UpdateProjectDto, AddProjectMemberDto, UpdateProjectMemberDto, AddColumnDto, UpdateColumnDto } from "./project.dto.js";

export const buildProjectRouter = (projectController) => {
  const projectRouter = Router();

// Projects
projectRouter.get('/workspace/:workspaceId/projects', isAuthenticated, checkWorkspaceRole('member'), projectController.getProjects);
projectRouter.post('/workspace/:workspaceId/projects', isAuthenticated, checkWorkspaceRole('owner', 'admin', 'member'), validate(CreateProjectDto), projectController.createProject);
projectRouter.post('/workspace/:workspaceId/project', isAuthenticated, checkWorkspaceRole('owner', 'admin', 'member'), validate(CreateProjectDto), projectController.createProject);
projectRouter.get('/project/:projectId', isAuthenticated, checkProjectRole('admin', 'member', 'viewer'), projectController.getProject);
projectRouter.get('/project/:projectId/overview', isAuthenticated, checkProjectRole('admin', 'member', 'viewer'), projectController.getProjectOverview);
projectRouter.put('/project/:projectId', isAuthenticated, checkProjectRole('admin'), validate(UpdateProjectDto), projectController.updateProject);
projectRouter.delete('/project/:projectId', isAuthenticated, checkProjectRole('admin'), projectController.deleteProject);
projectRouter.get('/project/:projectId/members', isAuthenticated, checkProjectRole('admin', 'member', 'viewer'), projectController.getProjectMembers);
projectRouter.post('/project/:projectId/members', isAuthenticated, checkProjectRole('admin'), validate(AddProjectMemberDto), projectController.addProjectMember);
projectRouter.put('/project/:projectId/members/:userId', isAuthenticated, checkProjectRole('admin'), validate(UpdateProjectMemberDto), projectController.updateProjectMember);
projectRouter.delete('/project/:projectId/members/:userId', isAuthenticated, checkProjectRole('admin'), projectController.removeProjectMember);

// Alias routes matching frontend queries (using PUT as requested by frontend)
projectRouter.put('/project/:projectId/add-member', isAuthenticated, checkProjectRole('admin'), validate(AddProjectMemberDto), projectController.addProjectMember);
projectRouter.put('/project/:projectId/update-member-role', isAuthenticated, checkProjectRole('admin'), projectController.updateProjectMember);
projectRouter.put('/project/:projectId/remove-member', isAuthenticated, checkProjectRole('admin'), projectController.removeProjectMember);

// Columns
projectRouter.post('/project/:projectId/columns', isAuthenticated, checkProjectRole('admin', 'member'), validate(AddColumnDto), projectController.addColumn);
projectRouter.put('/project/:projectId/columns/:columnId', isAuthenticated, checkProjectRole('admin', 'member'), validate(UpdateColumnDto), projectController.updateColumn);
projectRouter.delete('/project/:projectId/columns/:columnId', isAuthenticated, checkProjectRole('admin'), projectController.deleteColumn);

  return projectRouter;
}
