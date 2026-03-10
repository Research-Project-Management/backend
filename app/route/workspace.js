import { Router } from "express";
import WorkspaceModel from "../schema/workspace.js";
import RoleModel from "../schema/role.js";
import {
  isAuthenticated,
  checkWorkspaceRole,
} from "../middleware/checkWorkspaceRole.js";
import { initializeDefaultRoles } from "./role.js";
import {
  getCache,
  setCache,
  deleteCache,
  deleteCacheByPattern,
  userWorkspacesCacheKey,
  workspaceCacheKey,
  CACHE_DURATION,
} from "../libs/cache.js";

const workspaceRouter = Router();

// Lấy tất cả workspace của user
workspaceRouter.get("/", isAuthenticated, async (req, res) => {
  try {
    const cacheKey = userWorkspacesCacheKey(req.user._id);

    // Kiểm tra cache
    const cachedWorkspaces = await getCache(cacheKey);
    if (cachedWorkspaces) {
      return res.json({ workspaces: cachedWorkspaces, cached: true });
    }

    // Nếu không có cache, query DB
    const workspaces = await WorkspaceModel.find({
      "members.user": req.user._id,
    });

    // Lưu vào cache (5 phút)
    await setCache(cacheKey, workspaces, CACHE_DURATION.MEDIUM);

    res.json({ workspaces });
  } catch (error) {
    console.error("Error fetching workspaces:", error);
    res.status(500).json({ error: error.message });
  }
});

// Tạo workspace mới (user tạo sẽ là owner)
workspaceRouter.post("/", isAuthenticated, async (req, res) => {
  try {
    const { name, url, color, avatar } = req.body;

    // Tạo workspace
    const newWorkspace = new WorkspaceModel({
      name,
      url,
      color,
      avatar: avatar || "",
      members: [], // Sẽ thêm sau khi có roles
      createdBy: req.user._id,
    });
    await newWorkspace.save();

    // Khởi tạo default roles cho workspace
    const roleIds = await initializeDefaultRoles(
      newWorkspace._id,
      req.user._id,
    );

    // Thêm user tạo workspace là owner
    newWorkspace.members.push({
      user: req.user._id,
      role: roleIds.owner,
    });
    await newWorkspace.save();

    // Xóa cache của user
    await deleteCache(userWorkspacesCacheKey(req.user._id));

    res.status(201).json({ workspace: newWorkspace });
  } catch (error) {
    console.error("Error creating workspace:", error);
    res.status(500).json({ error: error.message });
  }
});

// Lấy chi tiết workspace (member trở lên)
// :workspaceId có thể là _id (ObjectId) HOẶC url (string)
workspaceRouter.get(
  "/:workspaceId",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    const workspace = await req.workspace.populate([
      { path: "members.user", select: "name email avatar" },
      { path: "members.role", select: "name color isDefault isSystem" },
    ]);
    res.json({ workspace, yourRole: req.workspaceRole });
  },
);

// Cập nhật workspace (admin trở lên)
workspaceRouter.put(
  "/:workspaceId",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin"),
  async (req, res) => {
    const { name, avatar } = req.body;
    const updateData = { name };
    if (avatar !== undefined) {
      updateData.avatar = avatar;
    }
    const workspace = await WorkspaceModel.findByIdAndUpdate(
      req.workspace._id,
      updateData,
      { new: true },
    );
    res.json({ workspace });
  },
);

// Thêm member (admin trở lên)
workspaceRouter.put(
  "/:workspaceId/add-member",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin"),
  async (req, res) => {
    const { userId, role = "member" } = req.body;

    // Admin không thể thêm owner hoặc admin khác
    if (req.workspaceRole === "admin" && ["owner", "admin"].includes(role)) {
      return res.status(403).json({ error: "Cannot add owner or admin" });
    }

    const workspace = req.workspace;

    // Kiểm tra đã là member chưa
    const existingMember = workspace.members.find(
      (m) => m.user.toString() === userId,
    );
    if (existingMember) {
      return res.status(400).json({ error: "User already a member" });
    }

    // Look up the Role document by name for this workspace
    const roleDoc = await RoleModel.findOne({
      workspace: workspace._id,
      name: { $regex: new RegExp(`^${role}$`, "i") },
    });
    if (!roleDoc) {
      return res
        .status(400)
        .json({ error: `Role "${role}" not found in this workspace` });
    }

    workspace.members.push({ user: userId, role: roleDoc._id });
    await workspace.save();
    res.json({ workspace });
  },
);

// Cập nhật role member (owner hoặc admin)
workspaceRouter.put(
  "/:workspaceId/update-member-role",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin"),
  async (req, res) => {
    const { userId, newRole } = req.body;
    const workspace = req.workspace;

    // Chỉ owner mới đổi được role thành admin/owner
    if (req.workspaceRole !== "owner" && ["owner", "admin"].includes(newRole)) {
      return res
        .status(403)
        .json({ error: "Only owner can assign admin/owner role" });
    }

    const member = workspace.members.find((m) => m.user.toString() === userId);
    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    // Look up the Role document by name for this workspace
    const roleDoc = await RoleModel.findOne({
      workspace: workspace._id,
      name: { $regex: new RegExp(`^${newRole}$`, "i") },
    });
    if (!roleDoc) {
      return res
        .status(400)
        .json({ error: `Role "${newRole}" not found in this workspace` });
    }

    member.role = roleDoc._id;
    await workspace.save();
    res.json({ workspace });
  },
);

// Xóa member (admin trở lên, không thể xóa owner)
workspaceRouter.put(
  "/:workspaceId/remove-member",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin"),
  async (req, res) => {
    const { userId } = req.body;
    const workspace = req.workspace;

    // Populate role to check role name
    const populatedWorkspace = await WorkspaceModel.findById(
      workspace._id,
    ).populate("members.role");
    const memberToRemove = populatedWorkspace.members.find(
      (m) => m.user.toString() === userId,
    );

    if (!memberToRemove) {
      return res.status(404).json({ error: "Member not found" });
    }

    // Không thể xóa owner
    if (memberToRemove.role?.name?.toLowerCase() === "owner") {
      return res.status(403).json({ error: "Cannot remove owner" });
    }

    // Admin không thể xóa admin khác
    if (
      req.workspaceRole === "admin" &&
      memberToRemove.role?.name?.toLowerCase() === "admin"
    ) {
      return res
        .status(403)
        .json({ error: "Admin cannot remove another admin" });
    }

    workspace.members = workspace.members.filter(
      (m) => m.user.toString() !== userId,
    );
    await workspace.save();
    res.json({ workspace });
  },
);

// Xóa workspace (chỉ owner)
workspaceRouter.delete(
  "/:workspaceId",
  isAuthenticated,
  checkWorkspaceRole("owner"),
  async (req, res) => {
    await WorkspaceModel.findByIdAndDelete(req.workspace._id);
    res.status(204).end();
  },
);

// Get recent items (pages, projects) in workspace
workspaceRouter.get(
  "/:workspaceId/recent",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    try {
      const { default: PageModel } = await import("../schema/page.js");
      const { default: ProjectModel } = await import("../schema/project.js");
      const { default: FileModel } = await import("../schema/file.js");

      const isPrivileged = ["owner", "admin"].includes(req.workspaceRole);

      // Build the set of accessible project IDs for this user
      const projectQuery = { workspace: req.workspace._id };
      if (!isPrivileged) projectQuery["members.user"] = req.user._id;
      const accessibleProjectIds =
        await ProjectModel.find(projectQuery).distinct("_id");

      // Get recent pages
      const recentPages = await PageModel.find({
        project: { $in: accessibleProjectIds },
      })
        .sort({ lastAccessedAt: -1 })
        .limit(5)
        .populate("author", "name avatar email")
        .populate("project", "name avatar");

      // Get recent projects (members only see their own projects)
      const recentProjects = await ProjectModel.find({
        _id: { $in: accessibleProjectIds },
      })
        .sort({ updatedAt: -1 })
        .limit(5)
        .populate("createdBy", "name avatar email");

      // Get recent files (scoped to accessible projects)
      const recentFiles = await FileModel.find({
        workspace: req.workspace._id,
        project: { $in: accessibleProjectIds },
        trashedAt: null,
      })
        .sort({ updatedAt: -1 })
        .limit(5)
        .populate("author", "name avatar email");

      // Combine and sort all items by date
      const allItems = [
        ...recentPages.map((p) => ({
          type: "page",
          id: p._id,
          name: p.title,
          icon: "📄",
          project: p.project,
          author: p.author,
          lastEdited: p.lastAccessedAt || p.updatedAt,
        })),
        ...recentProjects.map((p) => ({
          type: "project",
          id: p._id,
          name: p.name,
          icon: p.avatar || "📁",
          author: p.createdBy,
          lastEdited: p.updatedAt,
        })),
        ...recentFiles.map((f) => ({
          type: "file",
          id: f._id,
          name: f.filename,
          icon: "📎",
          author: f.author,
          lastEdited: f.updatedAt,
        })),
      ]
        .sort((a, b) => new Date(b.lastEdited) - new Date(a.lastEdited))
        .slice(0, 10);

      res.json({ items: allItems });
    } catch (error) {
      console.error("Error fetching recent items:", error);
      res.status(500).json({ error: "Failed to fetch recent items" });
    }
  },
);

// Get activity feed in workspace
workspaceRouter.get(
  "/:workspaceId/activity",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    try {
      const { default: PageModel } = await import("../schema/page.js");
      const { default: ProjectModel } = await import("../schema/project.js");
      const { default: FileModel } = await import("../schema/file.js");
      const { default: TaskModel } = await import("../schema/task.js");

      const isPrivileged = ["owner", "admin"].includes(req.workspaceRole);
      const projectQuery = { workspace: req.workspace._id };
      if (!isPrivileged) projectQuery["members.user"] = req.user._id;
      const accessibleProjectIds =
        await ProjectModel.find(projectQuery).distinct("_id");

      const activities = [];

      // Get recent page updates
      const recentPages = await PageModel.find({
        project: { $in: accessibleProjectIds },
      })
        .sort({ updatedAt: -1 })
        .limit(10)
        .populate("author", "name avatar email")
        .populate("project", "name");

      activities.push(
        ...recentPages.map((p) => ({
          type: "page_update",
          user: p.author,
          content: `updated page "${p.title}" in ${p.project?.name || "project"}`,
          time: p.updatedAt,
          itemId: p._id,
        })),
      );

      // Get recent file uploads (scoped to accessible projects)
      const recentFiles = await FileModel.find({
        workspace: req.workspace._id,
        project: { $in: accessibleProjectIds },
        trashedAt: null,
      })
        .sort({ createdAt: -1 })
        .limit(10)
        .populate("author", "name avatar email");

      activities.push(
        ...recentFiles.map((f) => ({
          type: "file_upload",
          user: f.author,
          content: `uploaded file "${f.filename}"`,
          time: f.createdAt,
          itemId: f._id,
        })),
      );

      // Get recent task updates (scoped to accessible projects)
      const recentTasks = await TaskModel.find({
        project: { $in: accessibleProjectIds },
      })
        .sort({ updatedAt: -1 })
        .limit(10)
        .populate("assignee", "name avatar email")
        .populate("author", "name avatar email");

      activities.push(
        ...recentTasks
          .filter((t) => t.assignee || t.author)
          .map((t) => ({
            type: "task_update",
            user: t.assignee || t.author,
            content: `updated task "${t.title}"`,
            time: t.updatedAt,
            itemId: t._id,
          })),
      );

      // Sort all activities by time
      const sortedActivities = activities
        .sort((a, b) => new Date(b.time) - new Date(a.time))
        .slice(0, 20);

      res.json({ activities: sortedActivities });
    } catch (error) {
      console.error("Error fetching activities:", error);
      res.status(500).json({ error: "Failed to fetch activities" });
    }
  },
);

export default workspaceRouter;
