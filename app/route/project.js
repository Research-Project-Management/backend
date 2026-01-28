import { Router } from "express";
import mongoose from "mongoose";
import ProjectModel from "../schema/project.js";
import WorkspaceModel from "../schema/workspace.js";
import FileModel from "../schema/file.js";
import {
  isAuthenticated,
  checkWorkspaceRole,
  checkProjectRole,
} from "../middleware/checkWorkspaceRole.js";

const projectRouter = Router();

// Lấy overview của project
projectRouter.get(
  "/project/:projectId/overview",
  isAuthenticated,
  checkProjectRole("manager", "member", "viewer"),
  async (req, res) => {
    try {
      const { projectId } = req.params;
      
      // 1. Get Project Details (already fetched in middleware but populating more if needed)
      const project = await req.project.populate([
        { path: "members.user", select: "name email avatar" },
        { path: "createdBy", select: "name email avatar" },
      ]);

      // 2. Get File Stats
      const fileCount = await FileModel.countDocuments({ project: projectId, trashedAt: null });
      const recentFiles = await FileModel.find({ project: projectId, trashedAt: null })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate("author", "name avatar");
      
      // Calculate total size
      const filesSizeAggregate = await FileModel.aggregate([
        { $match: { project: new mongoose.Types.ObjectId(projectId), trashedAt: null } },
        { $group: { _id: null, totalSize: { $sum: "$size" } } }
      ]);
      const totalSize = filesSizeAggregate.length > 0 ? filesSizeAggregate[0].totalSize : 0;

      // 3. Get Task Stats (If TaskModel exists later, add here. For now returning empty stats)
      const taskStats = {
        total: 0,
        completed: 0,
        pending: 0,
        inProgress: 0
      };

      res.json({
        project,
        stats: {
          files: {
            count: fileCount,
            totalSize,
            recent: recentFiles
          },
          tasks: taskStats,
          members: project.members.length
        }
      });
    } catch (error) {
      console.error("Overview Error:", error);
      res.status(500).json({ error: error.message });
    }
  }
);

// Lấy tất cả project trong workspace (member workspace trở lên)
projectRouter.get(
  "/workspace/:id/projects",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    try {
      const { includeInactive } = req.query;
      
      const baseQuery = {
        workspace: req.workspace._id,
        $or: [
          // Workspace owner/admin thấy tất cả project
          ...(["owner", "admin"].includes(req.workspaceRole)
            ? [{ workspace: req.workspace._id }]
            : []),
          // Member chỉ thấy project mình tham gia
          { "members.user": req.user._id },
        ],
      };

      // Chỉ admin/owner mới có thể xem inactive projects
      if (!includeInactive || !["owner", "admin"].includes(req.workspaceRole)) {
        baseQuery.isActive = true;
      }

      const projects = await ProjectModel.find(baseQuery)
        .populate("members.user", "name email")
        .populate("createdBy", "name email");

      res.json({ projects });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Tạo project mới (admin workspace trở lên)
projectRouter.post(
  "/workspace/:id/project",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin"),
  async (req, res) => {
    try {
      const { name, description, avatar, modules, settings } = req.body;

      const newProject = new ProjectModel({
        name,
        avatar: avatar || "",
        description: description || "",
        workspace: req.workspace._id,
        members: [{ user: req.user._id, role: "manager" }],
        createdBy: req.user._id,
        ...(modules && { modules }),
        ...(settings && { settings }),
      });

      await newProject.save();
      
      const populatedProject = await ProjectModel.findById(newProject._id)
        .populate("members.user", "name email")
        .populate("createdBy", "name email");
        
      res.status(201).json({ project: populatedProject });
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
      const project = await req.project.populate([
        { path: "members.user", select: "name email" },
        { path: "createdBy", select: "name email" },
      ]);
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
      const { name, description, avatar, modules, settings, isActive } = req.body;

      const updateData = {};
      if (name !== undefined) updateData.name = name;
      if (description !== undefined) updateData.description = description;
      if (avatar !== undefined) updateData.avatar = avatar;
      if (modules !== undefined) updateData.modules = modules;
      if (settings !== undefined) updateData.settings = settings;
      if (isActive !== undefined) updateData.isActive = isActive;

      const project = await ProjectModel.findByIdAndUpdate(
        req.params.projectId,
        updateData,
        { new: true }
      )
        .populate("members.user", "name email")
        .populate("createdBy", "name email");

      res.json({ project });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Toggle project active status (manager project hoặc admin workspace trở lên)
projectRouter.patch(
  "/project/:projectId/toggle-active",
  isAuthenticated,
  checkProjectRole("manager"),
  async (req, res) => {
    try {
      const project = req.project;
      project.isActive = !project.isActive;
      await project.save();

      res.json({ 
        project, 
        message: project.isActive ? "Project activated" : "Project deactivated" 
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Cập nhật modules của project (manager project hoặc admin workspace trở lên)
projectRouter.patch(
  "/project/:projectId/modules",
  isAuthenticated,
  checkProjectRole("manager"),
  async (req, res) => {
    try {
      const { modules } = req.body;

      if (!Array.isArray(modules)) {
        return res.status(400).json({ error: "Modules must be an array" });
      }

      const project = await ProjectModel.findByIdAndUpdate(
        req.params.projectId,
        { modules },
        { new: true }
      )
        .populate("members.user", "name email")
        .populate("createdBy", "name email");

      res.json({ project });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Cập nhật settings của project (manager project hoặc admin workspace trở lên)
projectRouter.patch(
  "/project/:projectId/settings",
  isAuthenticated,
  checkProjectRole("manager"),
  async (req, res) => {
    try {
      const { settings } = req.body;

      const project = await ProjectModel.findByIdAndUpdate(
        req.params.projectId,
        { settings },
        { new: true }
      )
        .populate("members.user", "name email")
        .populate("createdBy", "name email");

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

      const populatedProject = await ProjectModel.findById(project._id)
        .populate("members.user", "name email")
        .populate("createdBy", "name email");

      res.json({ project: populatedProject });
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
