import { Router } from "express";
import ProjectModel from "../schema/project.js";
import WorkspaceModel from "../schema/workspace.js";
import {
  isAuthenticated,
  checkWorkspaceRole,
  checkProjectRole,
} from "../middleware/checkWorkspaceRole.js";

const projectRouter = Router();

// Lấy tất cả project trong workspace (member workspace trở lên)
projectRouter.get(
  "/workspace/:id/projects",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    try {
      const projects = await ProjectModel.find({
        workspace: req.params.id,
        $or: [
          // Workspace owner/admin thấy tất cả project
          ...(["owner", "admin"].includes(req.workspaceRole)
            ? [{ workspace: req.params.id }]
            : []),
          // Member chỉ thấy project mình tham gia
          { "members.user": req.user._id },
        ],
      }).populate("members.user", "name email");

      res.json({ projects });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Tạo project mới (admin workspace trở lên)
projectRouter.post(
  "/workspace/:id/projects",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin"),
  async (req, res) => {
    try {
      const { title, description } = req.body;

      const newProject = new ProjectModel({
        title,
        description,
        workspace: req.params.id,
        members: [{ user: req.user._id, role: "manager" }],
        createdBy: req.user._id,
      });

      await newProject.save();
      res.status(201).json({ project: newProject });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Lấy chi tiết project (member project hoặc admin workspace trở lên)
projectRouter.get(
  "/project/:projectId",
  isAuthenticated,
  checkProjectRole("manager", "member", "viewer"),
  async (req, res) => {
    try {
      const project = await req.project.populate("members.user", "name email");
      res.json({ project, yourRole: req.projectRole });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Cập nhật project (manager project hoặc admin workspace trở lên)
projectRouter.put(
  "/project/:projectId",
  isAuthenticated,
  checkProjectRole("manager"),
  async (req, res) => {
    try {
      const { title, description } = req.body;

      const project = await ProjectModel.findByIdAndUpdate(
        req.params.projectId,
        { title, description },
        { new: true }
      );

      res.json({ project });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Xóa project (manager project hoặc admin workspace trở lên)
projectRouter.delete(
  "/project/:projectId",
  isAuthenticated,
  checkProjectRole("manager"),
  async (req, res) => {
    try {
      await ProjectModel.findByIdAndDelete(req.params.projectId);
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Thêm member vào project (manager project hoặc admin workspace trở lên)
projectRouter.put(
  "/project/:projectId/add-member",
  isAuthenticated,
  checkProjectRole("manager"),
  async (req, res) => {
    try {
      const { userId, role = "member" } = req.body;
      const project = req.project;

      // Kiểm tra user có trong workspace không
      const workspace = await WorkspaceModel.findById(project.workspace);
      const isWorkspaceMember = workspace.members.find(
        (m) => m.user.toString() === userId
      );

      if (!isWorkspaceMember) {
        return res
          .status(400)
          .json({ error: "User is not a member of this workspace" });
      }

      // Kiểm tra đã là member project chưa
      const existingMember = project.members.find(
        (m) => m.user.toString() === userId
      );

      if (existingMember) {
        return res
          .status(400)
          .json({ error: "User is already a member of this project" });
      }

      project.members.push({ user: userId, role });
      await project.save();

      res.json({ project });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Cập nhật role member trong project (manager project hoặc admin workspace trở lên)
projectRouter.put(
  "/project/:projectId/update-member-role",
  isAuthenticated,
  checkProjectRole("manager"),
  async (req, res) => {
    try {
      const { userId, newRole } = req.body;
      const project = req.project;

      const member = project.members.find((m) => m.user.toString() === userId);

      if (!member) {
        return res.status(404).json({ error: "Member not found in project" });
      }

      // Không thể thay đổi role của chính mình
      if (userId === req.user._id.toString()) {
        return res.status(400).json({ error: "Cannot change your own role" });
      }

      member.role = newRole;
      await project.save();

      res.json({ project });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Xóa member khỏi project (manager project hoặc admin workspace trở lên)
projectRouter.put(
  "/project/:projectId/remove-member",
  isAuthenticated,
  checkProjectRole("manager"),
  async (req, res) => {
    try {
      const { userId } = req.body;
      const project = req.project;

      const memberToRemove = project.members.find(
        (m) => m.user.toString() === userId
      );

      if (!memberToRemove) {
        return res.status(404).json({ error: "Member not found in project" });
      }

      // Không thể xóa chính mình
      if (userId === req.user._id.toString()) {
        return res.status(400).json({ error: "Cannot remove yourself" });
      }

      // Không thể xóa manager nếu mình không phải workspace admin/owner
      if (memberToRemove.role === "manager" && req.projectRole !== "manager") {
        return res.status(403).json({ error: "Cannot remove a manager" });
      }

      project.members = project.members.filter(
        (m) => m.user.toString() !== userId
      );
      await project.save();

      res.json({ project });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Rời khỏi project (tự rời, không phải manager cuối cùng)
projectRouter.put(
  "/project/:projectId/leave",
  isAuthenticated,
  checkProjectRole("manager", "member", "viewer"),
  async (req, res) => {
    try {
      const project = req.project;
      const userId = req.user._id.toString();

      const member = project.members.find((m) => m.user.toString() === userId);

      if (!member) {
        return res.status(404).json({ error: "You are not a member" });
      }

      // Nếu là manager, kiểm tra còn manager khác không
      if (member.role === "manager") {
        const otherManagers = project.members.filter(
          (m) => m.role === "manager" && m.user.toString() !== userId
        );

        if (otherManagers.length === 0) {
          return res.status(400).json({
            error:
              "Cannot leave. You are the only manager. Transfer ownership first.",
          });
        }
      }

      project.members = project.members.filter(
        (m) => m.user.toString() !== userId
      );
      await project.save();

      res.json({ message: "Left project successfully" });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

export default projectRouter;
