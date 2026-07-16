import { AppError } from "../lib/AppError.js";
import { PageModel } from "../contexts/manuscript/page/page.schema.js";
import ProjectModel from "../contexts/organization/project/project.schema.js";
import WorkspaceModel from "../contexts/organization/workspace/workspace.schema.js";

/**
 * checkPageRole — Application-layer middleware (infrastructure).
 * Resolves page → project → workspace membership chain and gates by role.
 * Attaches req.page and req.project for downstream handlers.
 */
export const checkPageRole = (...requiredRoles) => async (req, res, next) => {
  try {
    const page = await PageModel.findById(req.params.pageId);
    if (!page) throw new AppError("Page not found", 404);

    const project = await ProjectModel.findById(page.project);
    if (!project) throw new AppError("Project not found", 404);

    const workspace = await WorkspaceModel.findById(project.workspace).populate("members.role");
    const wsMember = workspace?.members.find((m) => m.user.toString() === req.user._id.toString());

    // Workspace owner/admin bypass
    if (wsMember?.role && ["owner", "admin"].includes(wsMember.role.name?.toLowerCase())) {
      req.page = page;
      req.project = project;
      return next();
    }

    // Check project-level role
    const populated = await ProjectModel.findById(project._id).populate("members.role");
    const projMember = populated.members.find((m) => m.user.toString() === req.user._id.toString());
    
    if (requiredRoles.length > 0) {
      if (!projMember?.role || !requiredRoles.includes(projMember.role.name?.toLowerCase())) {
        return next(new AppError("Insufficient permissions", 403));
      }
    } else {
      if (!projMember) {
        return next(new AppError("Insufficient permissions", 403));
      }
    }

    req.page = page;
    req.project = project;
    next();
  } catch (err) {
    next(err);
  }
};
