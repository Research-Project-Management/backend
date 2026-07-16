import { Router } from "express";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { checkWorkspaceRole } from "../../../middleware/workspace.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { CreateWorkspaceDto, UpdateWorkspaceDto, AddWorkspaceMemberDto, UpdateWorkspaceMemberDto, JoinWorkspaceDto } from "./workspace.dto.js";

export const buildWorkspaceRouter = (workspaceController) => {
  const workspaceRouter = Router();

workspaceRouter.get("/", isAuthenticated, workspaceController.getMyWorkspaces);
workspaceRouter.post("/", isAuthenticated, validate(CreateWorkspaceDto), workspaceController.createWorkspace);
workspaceRouter.get("/:workspaceId", isAuthenticated, checkWorkspaceRole("member"), workspaceController.getWorkspace);
workspaceRouter.put("/:workspaceId", isAuthenticated, checkWorkspaceRole("owner", "admin"), validate(UpdateWorkspaceDto), workspaceController.updateWorkspace);
workspaceRouter.delete("/:workspaceId", isAuthenticated, checkWorkspaceRole("owner"), workspaceController.deleteWorkspace);
workspaceRouter.get("/:workspaceId/members", isAuthenticated, checkWorkspaceRole("member"), workspaceController.getMembers);
workspaceRouter.post("/:workspaceId/members", isAuthenticated, checkWorkspaceRole("owner", "admin"), validate(AddWorkspaceMemberDto), workspaceController.addMember);
workspaceRouter.put("/:workspaceId/members/:userId", isAuthenticated, checkWorkspaceRole("owner", "admin"), validate(UpdateWorkspaceMemberDto), workspaceController.updateMember);
workspaceRouter.delete("/:workspaceId/members/:userId", isAuthenticated, checkWorkspaceRole("owner", "admin"), workspaceController.removeMember);

// Alias routes matching frontend queries (using PUT as requested by frontend)
workspaceRouter.put("/:workspaceId/add-member", isAuthenticated, checkWorkspaceRole("owner", "admin"), validate(AddWorkspaceMemberDto), workspaceController.addMember);
workspaceRouter.put("/:workspaceId/update-member-role", isAuthenticated, checkWorkspaceRole("owner", "admin"), workspaceController.updateMember);
workspaceRouter.put("/:workspaceId/remove-member", isAuthenticated, checkWorkspaceRole("owner", "admin"), workspaceController.removeMember);

workspaceRouter.post("/:workspaceId/invite", isAuthenticated, checkWorkspaceRole("owner", "admin"), validate(AddWorkspaceMemberDto), workspaceController.inviteMember);
workspaceRouter.post("/join/code", isAuthenticated, validate(JoinWorkspaceDto), workspaceController.joinWorkspace);
workspaceRouter.post("/:workspaceId/leave", isAuthenticated, checkWorkspaceRole("member"), workspaceController.leaveWorkspace);

// Recent items & Activity feeds
workspaceRouter.get("/:workspaceId/recent", isAuthenticated, checkWorkspaceRole("member"), workspaceController.getRecentItems);
workspaceRouter.get("/:workspaceId/activity", isAuthenticated, checkWorkspaceRole("member"), workspaceController.getActivityFeed);
workspaceRouter.get("/:workspaceId/search", isAuthenticated, checkWorkspaceRole("member"), workspaceController.searchWorkspace);

  return workspaceRouter;
}
