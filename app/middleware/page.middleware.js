import { AppError } from "../lib/AppError.js";
import PageModel from "../contexts/manuscript/page/page.schema.js";
import { getCachedProject } from "./project.middleware.js";
import { getCachedWorkspace } from "./workspace.middleware.js";

/**
 * checkPageRole — Application-layer middleware (infrastructure).
 * Resolves page → project → workspace membership chain and gates by role.
 * Attaches req.page and req.project for downstream handlers.
 */
export const checkPageRole = (...requiredRoles) => async (req, res, next) => {
  try {
    const page = await PageModel.findById(req.params.pageId);
    if (!page) throw new AppError("Page not found", 404);

    if (req.params.projectId && page.project.toString() !== req.params.projectId) {
      throw new AppError("Page does not belong to the specified project", 400);
    }

    const project = await getCachedProject(page.projectId || page.project);
    if (!project) throw new AppError("Project not found", 404);

    const workspace = await getCachedWorkspace(project.workspaceId || project.workspace);
    const wsMember = workspace?.members.find((m) => m.userId.toString() === req.user._id.toString());

    // Workspace owner/admin bypass
    if (wsMember?.roleId && ["owner", "admin"].includes(wsMember.roleId.name?.toLowerCase())) {
      req.page = page;
      req.project = project;
      return next();
    }

    // Check project-level role
    const projMember = project.members.find((m) => m.userId.toString() === req.user._id.toString());
    
    if (requiredRoles.length > 0) {
      const roleName = projMember?.roleId?.name?.toLowerCase();
      let effectiveAllowedRoles = [...requiredRoles];
      if (effectiveAllowedRoles.includes("viewer")) effectiveAllowedRoles.push("member", "admin", "owner", "manager");
      if (effectiveAllowedRoles.includes("member")) effectiveAllowedRoles.push("admin", "owner", "manager");
      if (effectiveAllowedRoles.includes("manager")) effectiveAllowedRoles.push("admin", "owner");
      if (effectiveAllowedRoles.includes("admin")) effectiveAllowedRoles.push("owner");

      if (!roleName || !effectiveAllowedRoles.includes(roleName)) {
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
