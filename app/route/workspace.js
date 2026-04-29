import { Router } from "express";
import CycleModel from "../schema/cycle.js";
import FileModel from "../schema/file.js";
import PageAssetModel from "../schema/pageAsset.js";
import PageCommentModel from "../schema/pageComment.js";
import PageModel from "../schema/page.js";
import PageVersionModel from "../schema/pageVersion.js";
import ProjectModel from "../schema/project.js";
import WorkspaceModel from "../schema/workspace.js";
import RoleModel from "../schema/role.js";
import { StickyModel, StickyNoteLinkModel, TagModel } from "../schema/sticky.js";
import TaskModel from "../schema/task.js";
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
    const workspace = await WorkspaceModel.populate(req.workspace, [
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
    try {
      const { name, avatar } = req.body;
      const updateData = { name };
      if (avatar !== undefined) {
        updateData.avatar = avatar;
      }

      const memberIds = Array.from(
        new Set(
          (req.workspace?.members || [])
            .map((member) => member.user?.toString())
            .filter(Boolean),
        ),
      );

      const workspace = await WorkspaceModel.findByIdAndUpdate(
        req.workspace._id,
        updateData,
        { new: true },
      );

      await Promise.allSettled([
        ...memberIds.map((userId) =>
          deleteCache(userWorkspacesCacheKey(userId)),
        ),
        deleteCache(workspaceCacheKey(req.workspace._id.toString())),
        deleteCacheByPattern(`workspace:${req.workspace._id.toString()}*`),
      ]);

      res.json({ workspace });
    } catch (error) {
      console.error("Error updating workspace:", error);
      res.status(500).json({ error: error.message });
    }
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

// Xóa workspace
workspaceRouter.delete(
  "/:workspaceId",
  isAuthenticated,
  async (req, res) => {
    try {
      const { workspaceId: rawWorkspaceId } = req.params;
      const isObjectId = /^[0-9a-fA-F]{24}$/.test(rawWorkspaceId);

      const workspace = isObjectId
        ? await WorkspaceModel.findById(rawWorkspaceId).populate("members.role")
        : await WorkspaceModel.findOne({ url: rawWorkspaceId }).populate("members.role");

      if (!workspace) {
        return res.status(404).json({ error: "Workspace not found" });
      }

      const member = (workspace.members || []).find(
        (m) => m.user?.toString() === req.user._id.toString(),
      );

      const memberRoleName = member?.role?.name?.toLowerCase();
      const isOwnerByRole = memberRoleName === "owner";
      const isOwnerByCreator =
        workspace.createdBy?.toString() === req.user._id.toString();

      if (!isOwnerByRole && !isOwnerByCreator) {
        return res.status(403).json({ error: "Only owner can delete workspace" });
      }

      const workspaceId = workspace._id.toString();
      const memberIds = (workspace.members || [])
        .map((m) => m.user?.toString())
        .filter(Boolean);
      const projectIds = await ProjectModel.find({
        workspace: workspace._id,
      }).distinct("_id");
      const pageIds =
        projectIds.length > 0
          ? await PageModel.find({
              project: { $in: projectIds },
            }).distinct("_id")
          : [];

      await Promise.all([
        TaskModel.deleteMany({ project: { $in: projectIds } }),
        CycleModel.deleteMany({ project: { $in: projectIds } }),
        PageAssetModel.deleteMany({
          $or: [
            { project: { $in: projectIds } },
            { parentPage: { $in: pageIds } },
          ],
        }),
        PageCommentModel.deleteMany({
          $or: [
            { page: { $in: pageIds } },
            { projectPageId: { $in: pageIds } },
          ],
        }),
        PageVersionModel.deleteMany({
          $or: [
            { page: { $in: pageIds } },
            { projectPageId: { $in: pageIds } },
          ],
        }),
        PageModel.deleteMany({ project: { $in: projectIds } }),
        FileModel.deleteMany({ workspace: workspace._id }),
        ProjectModel.deleteMany({ workspace: workspace._id }),
        RoleModel.deleteMany({ workspace: workspace._id }),
        StickyModel.deleteMany({ workspace: workspace._id }),
        StickyNoteLinkModel.deleteMany({ workspace: workspace._id }),
        TagModel.deleteMany({ workspace: workspace._id }),
      ]);

      await WorkspaceModel.findByIdAndDelete(workspaceId);

      const cacheCleanupResults = await Promise.allSettled([
        ...memberIds.map(async (userId) => {
          const freshWorkspaces = await WorkspaceModel.find({
            "members.user": userId,
          });
          return setCache(
            userWorkspacesCacheKey(userId),
            freshWorkspaces,
            CACHE_DURATION.MEDIUM,
          );
        }),
        ...(!memberIds.includes(req.user._id.toString())
          ? [deleteCache(userWorkspacesCacheKey(req.user._id))]
          : []),
        deleteCache(workspaceCacheKey(workspaceId)),
        deleteCacheByPattern(`workspace:${workspaceId}*`),
      ]);

      cacheCleanupResults.forEach((result, index) => {
        if (result.status === "rejected") {
          console.warn(
            `Workspace delete cache cleanup failed at step ${index}:`,
            result.reason,
          );
        }
      });

      res.status(204).end();
    } catch (error) {
      console.error("Error deleting workspace:", error);
      res
        .status(500)
        .json({ error: error?.message || "Failed to delete workspace" });
    }
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

// Search everything in workspace
workspaceRouter.get(
  "/:workspaceId/search",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    try {
      const { q } = req.query;
      if (!q || typeof q !== "string" || q.trim().length < 1) {
        return res.json({ results: [] });
      }

      const { default: PageModel } = await import("../schema/page.js");
      const { default: ProjectModel } = await import("../schema/project.js");
      const { default: FileModel } = await import("../schema/file.js");
      const { default: StickyModel } = await import("../schema/sticky.js");

      const searchRegex = { $regex: q.trim(), $options: "i" };
      const isPrivileged = ["owner", "admin"].includes(req.workspaceRole);

      // Get accessible project IDs
      const projectQuery = { workspace: req.workspace._id };
      if (!isPrivileged) projectQuery["members.user"] = req.user._id;
      const accessibleProjectIds =
        await ProjectModel.find(projectQuery).distinct("_id");

      // Search in parallel
      const [projects, pages, files, stickies] = await Promise.all([
        ProjectModel.find({
          _id: { $in: accessibleProjectIds },
          name: searchRegex,
        })
          .limit(5)
          .select("name avatar updatedAt"),
        PageModel.find({
          project: { $in: accessibleProjectIds },
          title: searchRegex,
        })
          .limit(5)
          .select("title project updatedAt")
          .populate("project", "name"),
        // Files: include workspace-level files (project null) AND project-scoped files
        FileModel.find({
          workspace: req.workspace._id,
          $or: [
            { project: { $in: accessibleProjectIds } },
            { project: null },
          ],
          filename: searchRegex,
          trashedAt: null,
        })
          .limit(5)
          .select("filename mimeType size updatedAt project isFolder"),
        // Stickies: search by title or content
        StickyModel.find({
          workspace: req.workspace._id,
          $or: [
            { title: searchRegex },
            { content: searchRegex },
          ],
        })
          .limit(5)
          .select("title content color updatedAt"),
      ]);

      const results = [
        ...projects.map((p) => ({
          type: "project",
          id: p._id,
          name: p.name,
          icon: p.avatar || null,
          updatedAt: p.updatedAt,
        })),
        ...pages.map((p) => ({
          type: "page",
          id: p._id,
          name: p.title,
          projectId: p.project?._id,
          projectName: p.project?.name,
          updatedAt: p.updatedAt,
        })),
        ...files.map((f) => ({
          type: f.isFolder ? "folder" : "file",
          id: f._id,
          name: f.filename,
          mimeType: f.mimeType,
          size: f.size,
          projectId: f.project,
          updatedAt: f.updatedAt,
        })),
        ...stickies.map((s) => {
          const stripHtml = (str) => str?.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim() || "";
          return {
            type: "sticky",
            id: s._id,
            name: stripHtml(s.title) || "Untitled",
            content: stripHtml(s.content)?.substring(0, 80) || "",
            color: s.color,
            updatedAt: s.updatedAt,
          };
        }),
      ];

      res.json({ results });
    } catch (error) {
      console.error("Error searching workspace:", error);
      res.status(500).json({ error: "Search failed" });
    }
  },
);

// Get research overview for "Your Works" — cycles + upcoming deadlines
workspaceRouter.get(
  "/:workspaceId/my-research",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    try {
      const { default: ProjectModel } = await import("../schema/project.js");
      const { default: CycleModel } = await import("../schema/cycle.js");
      const { default: TaskModel } = await import("../schema/task.js");

      const isPrivileged = ["owner", "admin"].includes(req.workspaceRole);
      const projectQuery = { workspace: req.workspace._id };
      if (!isPrivileged) projectQuery["members.user"] = req.user._id;
      const accessibleProjects = await ProjectModel.find(projectQuery).select(
        "name avatar",
      );
      const accessibleProjectIds = accessibleProjects.map((p) => p._id);
      const projectMap = Object.fromEntries(
        accessibleProjects.map((p) => [
          p._id.toString(),
          { _id: p._id, name: p.name, avatar: p.avatar },
        ]),
      );

      // 1. Active cycles across all projects
      const cycles = await CycleModel.find({
        project: { $in: accessibleProjectIds },
        status: { $in: ["active", "planned"] },
      })
        .sort({ status: 1, order: 1 })
        .populate("author", "name avatar");

      // Compute task stats for each cycle
      const cycleIds = cycles.map((c) => c._id);
      const cycleTasks = await TaskModel.find({
        cycle: { $in: cycleIds },
      }).select("cycle columnId");

      const cycleStatsMap = {};
      cycleTasks.forEach((t) => {
        const key = t.cycle?.toString();
        if (!key) return;
        if (!cycleStatsMap[key]) cycleStatsMap[key] = { total: 0, done: 0 };
        cycleStatsMap[key].total++;
        if (t.columnId === "done") cycleStatsMap[key].done++;
      });

      const cyclesData = cycles.map((c) => {
        const stats = cycleStatsMap[c._id.toString()] || {
          total: 0,
          done: 0,
        };
        return {
          _id: c._id,
          name: c.name,
          description: c.description,
          phase: c.phase,
          status: c.status,
          startDate: c.startDate,
          endDate: c.endDate,
          milestones: c.milestones,
          deliverables: c.deliverables,
          project: projectMap[c.project.toString()] || null,
          author: c.author,
          stats: {
            totalTasks: stats.total,
            completedTasks: stats.done,
            progress: stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0,
          },
        };
      });

      // 2. Upcoming deadlines: milestones (next 14 days) + tasks with dueDate
      const now = new Date();
      const in14Days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

      // Milestone deadlines from cycles
      const milestoneDeadlines = [];
      cycles.forEach((c) => {
        (c.milestones || []).forEach((m) => {
          if (!m.dueDate) return;
          const d = new Date(m.dueDate);
          // Include overdue (not completed) + upcoming 14 days
          if ((!m.completed && d < now) || (d >= now && d <= in14Days)) {
            milestoneDeadlines.push({
              type: "milestone",
              id: m._id?.toString(),
              title: m.title,
              dueDate: m.dueDate,
              completed: m.completed,
              cycleName: c.name,
              cycleId: c._id,
              project: projectMap[c.project.toString()] || null,
              isOverdue: !m.completed && d < now,
            });
          }
        });
      });

      // Task deadlines
      const taskDeadlines = await TaskModel.find({
        project: { $in: accessibleProjectIds },
        assignee: req.user._id,
        dueDate: { $exists: true, $ne: null },
        $or: [
          { dueDate: { $lt: now }, columnId: { $ne: "done" } }, // overdue
          { dueDate: { $gte: now, $lte: in14Days } }, // upcoming
        ],
      })
        .sort({ dueDate: 1 })
        .limit(20)
        .select("title dueDate columnId priority project identifier")
        .populate("project", "name avatar");

      const taskDeadlinesData = taskDeadlines.map((t) => ({
        type: "task",
        id: t._id,
        title: t.title,
        identifier: t.identifier,
        dueDate: t.dueDate,
        completed: t.columnId === "done",
        priority: t.priority,
        project: t.project,
        isOverdue:
          t.columnId !== "done" && new Date(t.dueDate) < now,
      }));

      // Merge and sort: overdue first, then by date
      const deadlines = [...milestoneDeadlines, ...taskDeadlinesData].sort(
        (a, b) => {
          if (a.isOverdue && !b.isOverdue) return -1;
          if (!a.isOverdue && b.isOverdue) return 1;
          return new Date(a.dueDate) - new Date(b.dueDate);
        },
      );

      res.json({ cycles: cyclesData, deadlines });
    } catch (error) {
      console.error("Error fetching research overview:", error);
      res.status(500).json({ error: "Failed to fetch research overview" });
    }
  },
);

export default workspaceRouter;
