import { Router } from "express";
import mongoose from "mongoose";
import CycleModel from "../schema/cycle.js";
import ProjectModel from "../schema/project.js";
import WorkspaceModel from "../schema/workspace.js";
import FileModel from "../schema/file.js";
import PageAssetModel from "../schema/pageAsset.js";
import PageCommentModel from "../schema/pageComment.js";
import PageModel from "../schema/page.js";
import PageVersionModel from "../schema/pageVersion.js";
import RoleModel from "../schema/role.js";
import { StickyModel, StickyNoteLinkModel } from "../schema/sticky.js";
import TaskCommentModel from "../schema/taskComment.js";
import TaskModel from "../schema/task.js";
import {
  isAuthenticated,
  checkWorkspaceRole,
  checkProjectRole,
  clearProjectCache,
} from "../middleware/checkWorkspaceRole.js";
import { asyncHandler } from "../middleware/helpers.js";
import { getFileIcon } from "../libs/fileUtils.js";


const projectRouter = Router();



// Lấy overview của project
projectRouter.get(
  "/project/:projectId/overview",
  isAuthenticated,
  checkProjectRole("manager", "member", "viewer"),
  asyncHandler(async (req, res) => {
    const { projectId } = req.params;

    // 1. Get Project Details (already fetched in middleware but populating more if needed)
    const project = await ProjectModel.findById(req.project._id).populate([
      { path: "members.user", select: "name email avatar" },
      { path: "createdBy", select: "name email avatar" },
    ]);
    if (!project) return res.status(404).json({ error: "Project not found" });

    // 2. Get File Stats
    const fileCount = await FileModel.countDocuments({
      project: projectId,
      trashedAt: null,
    });
    const recentFiles = await FileModel.find({
      project: projectId,
      trashedAt: null,
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("author", "name avatar");

    // Calculate total size
    const filesSizeAggregate = await FileModel.aggregate([
      {
        $match: {
          project: new mongoose.Types.ObjectId(projectId),
          trashedAt: null,
        },
      },
      { $group: { _id: null, totalSize: { $sum: "$size" } } },
    ]);
    const totalSize =
      filesSizeAggregate.length > 0 ? filesSizeAggregate[0].totalSize : 0;

    // 3. Get Task Stats
    const totalTasks = await TaskModel.countDocuments({ project: projectId });
    const completedTasks = await TaskModel.countDocuments({
      project: projectId,
      $or: [{ columnId: "done" }, { completed: true }],
    });

    const taskStats = {
      total: totalTasks,
      completed: completedTasks,
      pending: 0,
      inProgress: 0,
    };

    res.json({
      project,
      stats: {
        files: {
          count: fileCount,
          totalSize,
          recent: recentFiles,
        },
        tasks: taskStats,
        members: project.members.length,
      },
    });
  }),
);


// Lấy tất cả project trong workspace (member workspace trở lên)
projectRouter.get(
  "/workspace/:workspaceId/projects",
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
  },
);

// Tạo project mới (admin workspace trở lên)
projectRouter.post(
  "/workspace/:workspaceId/project",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin"),
  async (req, res) => {
    try {
      const { name, description, avatar, modules, settings } = req.body;

      // Sử dụng role Owner của workspace làm default manager cho project
      // (User tạo project sẽ có quyền manager/owner)
      const RoleModel = (await import("../schema/role.js")).default;

      // Tìm Owner role trong workspace để dùng làm manager cho project
      const ownerRole = await RoleModel.findOne({
        workspace: req.workspace._id,
        name: { $regex: /^owner$/i },
        isSystem: true,
      });

      if (!ownerRole) {
        return res.status(500).json({
          error: "Workspace roles not initialized. Please run migration.",
        });
      }

      const newProject = new ProjectModel({
        name,
        avatar: avatar || "",
        description: description || "",
        workspace: req.workspace._id,
        members: [
          {
            user: req.user._id,
            role: ownerRole._id,
          },
        ],
        createdBy: req.user._id,
        ...(modules && { modules }),
        ...(settings && { settings }),
      });

      await newProject.save();

      const populatedProject = await ProjectModel.findById(newProject._id)
        .populate("members.user", "name email")
        .populate("members.role", "name color")
        .populate("createdBy", "name email");

      res.status(201).json({ project: populatedProject });
    } catch (error) {
      console.error("Error creating project:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

// Lấy chi tiết project (member project hoặc admin workspace trở lên)
projectRouter.get(
  "/project/:projectId",
  isAuthenticated,
  checkProjectRole("manager", "member", "viewer"),
  async (req, res) => {
    try {
      const project = await ProjectModel.findById(req.project._id).populate([
        { path: "members.user", select: "name email avatar" },
        { path: "createdBy", select: "name email avatar" },
        { path: "workspace", select: "_id name" },
      ]);
      if (!project) return res.status(404).json({ error: "Project not found" });
      res.json({ project, yourRole: req.projectRole });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Cập nhật project (manager project hoặc admin workspace trở lên)
projectRouter.put(
  "/project/:projectId",
  isAuthenticated,
  checkProjectRole("manager"),
  async (req, res) => {
    try {
      const { name, description, avatar, modules, settings, isActive } =
        req.body;

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
        { new: true },
      )
        .populate("members.user", "name email")
        .populate("createdBy", "name email");

      if (project) {
        await clearProjectCache(req.params.projectId);
      }

      res.json({ project });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Toggle project active status (manager project hoặc admin workspace trở lên)
projectRouter.patch(
  "/project/:projectId/toggle-active",
  isAuthenticated,
  checkProjectRole("manager"),
  async (req, res) => {
    try {
      const project = await ProjectModel.findById(req.project._id);
      if (!project) return res.status(404).json({ error: "Project not found" });
      project.isActive = !project.isActive;
      await project.save();

      if (project) {
        await clearProjectCache(req.project._id);
      }

      res.json({
        project,
        message: project.isActive ? "Project activated" : "Project deactivated",
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
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
        { new: true },
      )
        .populate("members.user", "name email")
        .populate("createdBy", "name email");

      if (project) {
        await clearProjectCache(req.params.projectId);
      }

      res.json({ project });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
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
        { new: true },
      )
        .populate("members.user", "name email")
        .populate("createdBy", "name email");

      if (project) {
        await clearProjectCache(req.params.projectId);
      }

      res.json({ project });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Xóa project (manager project hoặc admin workspace trở lên)
projectRouter.delete(
  "/project/:projectId",
  isAuthenticated,
  checkProjectRole("manager"),
  async (req, res) => {
    try {
      const projectId = req.params.projectId;
      const pageIds = await PageModel.find({ project: projectId }).distinct("_id");

      await Promise.all([
        TaskCommentModel.deleteMany({ project: projectId }),
        TaskModel.deleteMany({ project: projectId }),
        CycleModel.deleteMany({ project: projectId }),
        PageAssetModel.deleteMany({
          $or: [{ project: projectId }, { parentPage: { $in: pageIds } }],
        }),
        PageCommentModel.deleteMany({
          $or: [{ page: { $in: pageIds } }, { projectPageId: { $in: pageIds } }],
        }),
        PageVersionModel.deleteMany({
          $or: [{ page: { $in: pageIds } }, { projectPageId: { $in: pageIds } }],
        }),
        PageModel.deleteMany({ project: projectId }),
        FileModel.deleteMany({ project: projectId }),
        StickyModel.deleteMany({ projectId }),
        StickyNoteLinkModel.deleteMany({ project: projectId }),
        RoleModel.deleteMany({ project: projectId }),
      ]);

      await ProjectModel.findByIdAndDelete(projectId);
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Thêm member vào project (manager project hoặc admin workspace trở lên)
projectRouter.put(
  "/project/:projectId/add-member",
  isAuthenticated,
  checkProjectRole("manager"),
  async (req, res) => {
    try {
      const { userId, role = "member" } = req.body;
      const project = await ProjectModel.findById(req.project._id);
      if (!project) return res.status(404).json({ error: "Project not found" });

      // Kiểm tra user có trong workspace không
      const workspace = await WorkspaceModel.findById(project.workspace);
      const isWorkspaceMember = workspace.members.find(
        (m) => m.user.toString() === userId,
      );

      if (!isWorkspaceMember) {
        return res
          .status(400)
          .json({ error: "User is not a member of this workspace" });
      }

      // Kiểm tra đã là member project chưa
      const existingMember = project.members.find(
        (m) => m.user.toString() === userId,
      );

      if (existingMember) {
        return res
          .status(400)
          .json({ error: "User is already a member of this project" });
      }

      // Look up the Role document by name for this workspace
      const roleDoc = await RoleModel.findOne({
        workspace: project.workspace,
        name: { $regex: new RegExp(`^${role}$`, "i") },
      });
      if (!roleDoc) {
        return res
          .status(400)
          .json({ error: `Role "${role}" not found in this workspace` });
      }

      await ProjectModel.findByIdAndUpdate(project._id, {
        $push: { members: { user: userId, role: roleDoc._id } }
      });

      const populatedProject = await ProjectModel.findById(project._id)
        .populate("members.user", "name email")
        .populate("createdBy", "name email");

      res.json({ project: populatedProject });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Cập nhật role member trong project (manager project hoặc admin workspace trở lên)
projectRouter.put(
  "/project/:projectId/update-member-role",
  isAuthenticated,
  checkProjectRole("manager"),
  async (req, res) => {
    try {
      const { userId, newRole } = req.body;
      const project = await ProjectModel.findById(req.project._id);
      if (!project) return res.status(404).json({ error: "Project not found" });

      const member = project.members.find((m) => m.user.toString() === userId);

      if (!member) {
        return res.status(404).json({ error: "Member not found in project" });
      }

      // Không thể thay đổi role của chính mình
      if (userId === req.user._id.toString()) {
        return res.status(400).json({ error: "Cannot change your own role" });
      }

      // Look up the Role document by name for this workspace
      const roleDoc = await RoleModel.findOne({
        workspace: project.workspace,
        name: { $regex: new RegExp(`^${newRole}$`, "i") },
      });
      if (!roleDoc) {
        return res
          .status(400)
          .json({ error: `Role "${newRole}" not found in this workspace` });
      }

      await ProjectModel.updateOne(
        { _id: project._id, "members.user": userId },
        { $set: { "members.$.role": roleDoc._id } }
      );

      res.json({ project });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Xóa member khỏi project (manager project hoặc admin workspace trở lên)
projectRouter.put(
  "/project/:projectId/remove-member",
  isAuthenticated,
  checkProjectRole("manager"),
  async (req, res) => {
    try {
      const { userId } = req.body;
      const project = await ProjectModel.findById(req.project._id).populate("members.role");
      if (!project) return res.status(404).json({ error: "Project not found" });

      const memberToRemove = project.members.find(
        (m) => m.user.toString() === userId,
      );

      if (!memberToRemove) {
        return res.status(404).json({ error: "Member not found in project" });
      }

      // Không thể xóa chính mình
      if (userId === req.user._id.toString()) {
        return res.status(400).json({ error: "Cannot remove yourself" });
      }

      // Không thể xóa manager nếu mình không phải workspace admin/owner
      if (
        memberToRemove?.role?.name?.toLowerCase() === "manager" &&
        req.projectRole !== "manager"
      ) {
        return res.status(403).json({ error: "Cannot remove a manager" });
      }

      project.members = project.members.filter(
        (m) => m.user.toString() !== userId,
      );
      await project.save();

      res.json({ project });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Rời khỏi project (tự rời, không phải manager cuối cùng)
projectRouter.put(
  "/project/:projectId/leave",
  isAuthenticated,
  checkProjectRole("manager", "member", "viewer"),
  async (req, res) => {
    try {
      const project = await ProjectModel.findById(req.project._id).populate("members.role");
      if (!project) return res.status(404).json({ error: "Project not found" });
      const userId = req.user._id.toString();

      const member = project.members.find(
        (m) => m.user.toString() === userId,
      );

      if (!member) {
        return res.status(404).json({ error: "You are not a member" });
      }

      // Nếu là manager, kiểm tra còn manager khác không
      if (member.role?.name?.toLowerCase() === "manager") {
        const otherManagers = project.members.filter(
          (m) =>
            m.role?.name?.toLowerCase() === "manager" &&
            m.user.toString() !== userId,
        );

        if (otherManagers.length === 0) {
          return res.status(400).json({
            error:
              "Cannot leave. You are the only manager. Transfer ownership first.",
          });
        }
      }

      project.members = project.members.filter(
        (m) => m.user.toString() !== userId,
      );
      await project.save();

      res.json({ message: "Left project successfully" });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Get recent items (projects, pages, files) for workspace home
projectRouter.get(
  "/workspace/:id/recent",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    try {
      const userId = req.user._id;
      const workspaceId = req.workspace._id;
      const limit = parseInt(req.query.limit) || 10;

      // Get recent projects user has access to
      const recentProjects = await ProjectModel.find({
        workspace: workspaceId,
        isActive: true,
        $or: [
          { "members.user": userId },
          ...(["owner", "admin"].includes(req.workspaceRole)
            ? [{ workspace: workspaceId }]
            : []),
        ],
      })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .select("name avatar updatedAt")
        .lean();

      // Get recent files
      const recentFiles = await FileModel.find({
        workspace: workspaceId,
        trashedAt: null,
        $or: [
          { author: userId },
          ...(["owner", "admin"].includes(req.workspaceRole)
            ? [{ workspace: workspaceId }]
            : []),
        ],
      })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .select("filename url updatedAt mimeType")
        .lean();

      // Combine and sort by most recent
      const recentItems = [
        ...recentProjects.map((p) => ({
          type: "project",
          id: p._id,
          name: p.name,
          icon: p.avatar,
          lastEdited: p.updatedAt,
        })),
        ...recentFiles.map((f) => ({
          type: "file",
          id: f._id,
          name: f.filename,
          icon: getFileIcon(f.mimeType),
          lastEdited: f.updatedAt,
        })),
      ]
        .sort((a, b) => new Date(b.lastEdited) - new Date(a.lastEdited))
        .slice(0, limit);

      res.json({ items: recentItems });
    } catch (error) {
      console.error("Recent items error:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

// Get recent activities for workspace home
projectRouter.get(
  "/workspace/:id/activities",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    try {
      const workspaceId = req.workspace._id;
      const limit = parseInt(req.query.limit) || 20;

      // Get recent file uploads
      const recentFiles = await FileModel.find({
        workspace: workspaceId,
        trashedAt: null,
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate("author", "name email avatar")
        .select("filename createdAt author")
        .lean();

      // Get recent projects
      const recentProjects = await ProjectModel.find({
        workspace: workspaceId,
        isActive: true,
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate("createdBy", "name email avatar")
        .select("name createdAt createdBy")
        .lean();

      // Combine activities
      const activities = [
        ...recentFiles.map((f) => ({
          type: "file_upload",
          user: f.author?.name || "Unknown",
          userAvatar: f.author?.avatar || null,
          content: `uploaded ${f.filename}`,
          time: f.createdAt,
        })),
        ...recentProjects.map((p) => ({
          type: "project_created",
          user: p.createdBy?.name || "Unknown",
          userAvatar: p.createdBy?.avatar || null,
          content: `created project ${p.name}`,
          time: p.createdAt,
        })),
      ]
        .sort((a, b) => new Date(b.time) - new Date(a.time))
        .slice(0, limit);

      res.json({ activities });
    } catch (error) {
      console.error("Activities error:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

export default projectRouter;
