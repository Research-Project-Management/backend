import { Router } from "express";
import TaskModel from "../schema/task.js";
import ProjectModel from "../schema/project.js";
import WorkspaceModel from "../schema/workspace.js";
import {
  isAuthenticated,
  checkProjectRole,
} from "../middleware/checkWorkspaceRole.js";

const taskRouter = Router();

const checkTaskAccess = (requiredRoles) => {
  return async (req, res, next) => {
    try {
      const task = await TaskModel.findById(req.params.taskId);
      if (!task) return res.status(404).json({ error: "Task not found" });

      const project = await ProjectModel.findById(task.project).populate(
        "members.role",
      );
      if (!project) return res.status(404).json({ error: "Project not found" });

      const workspace = await WorkspaceModel.findById(
        project.workspace,
      ).populate("members.role");
      const workspaceMember = workspace.members.find(
        (m) => m.user.toString() === req.user._id.toString(),
      );

      // Workspace owners and admins always have access
      if (workspaceMember && workspaceMember.role) {
        const wsRoleName = workspaceMember.role.name?.toLowerCase();
        if (["owner", "admin"].includes(wsRoleName)) {
          return next();
        }
      }

      // Check project member role
      const projectMember = project.members.find(
        (m) => m.user.toString() === req.user._id.toString(),
      );

      if (!projectMember) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      // Get role name from populated role object
      const role = projectMember.role;
      if (!role || !role.name) {
        return res.status(403).json({ error: "Role not found" });
      }

      const roleName = role.name.toLowerCase();

      if (!requiredRoles.includes(roleName)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      next();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
};

// Get Tasks and Columns
taskRouter.get(
  "/project/:projectId/tasks",
  isAuthenticated,
  checkProjectRole("manager", "member", "viewer"),
  async (req, res) => {
    try {
      const { projectId } = req.params;
      const tasks = await TaskModel.find({ project: projectId })
        .populate("assignee", "name avatar")
        .sort({ rank: 1 });

      const project =
        await ProjectModel.findById(projectId).select("taskColumns");

      res.json({ tasks, columns: project.taskColumns });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Get All Tasks in Workspace
taskRouter.get(
  "/workspace/:workspaceId/tasks",
  isAuthenticated,
  async (req, res) => {
    try {
      const { workspaceId } = req.params;

      // Check if user has access to workspace (find by URL)
      const workspace = await WorkspaceModel.findOne({ url: workspaceId });
      if (!workspace) {
        return res.status(404).json({ error: "Workspace not found" });
      }

      const workspaceMember = workspace.members.find(
        (m) => m.user.toString() === req.user._id.toString(),
      );

      if (!workspaceMember) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Get all projects in workspace
      const projects = await ProjectModel.find({ workspace: workspace._id });
      const projectIds = projects.map((p) => p._id);

      // Get all tasks from these projects
      const tasks = await TaskModel.find({
        project: { $in: projectIds },
        assignee: req.user._id, // Only get tasks assigned to current user
      })
        .populate("assignee", "name avatar")
        .populate({
          path: "project",
          select: "name emoji",
        })
        .sort({ createdAt: -1 });

      res.json({ tasks });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Create Task
taskRouter.post(
  "/project/:projectId/tasks",
  isAuthenticated,
  checkProjectRole("manager", "member"),
  async (req, res) => {
    try {
      const { title, columnId, content, assignee, dueDate, labels } = req.body;
      const { projectId } = req.params;

      const count = await TaskModel.countDocuments({
        project: projectId,
        columnId,
      });

      const newTask = new TaskModel({
        title,
        content,
        columnId,
        project: projectId,
        assignee,
        dueDate,
        labels,
        rank: count + 1,
        author: req.user._id,
      });

      await newTask.save();
      await newTask.populate("assignee", "name avatar");

      res.status(201).json({ task: newTask });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Update Task
taskRouter.put(
  "/tasks/:taskId",
  isAuthenticated,
  checkTaskAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const { taskId } = req.params;
      const updateData = req.body;

      const updatedTask = await TaskModel.findByIdAndUpdate(
        taskId,
        updateData,
        { new: true },
      ).populate("assignee", "name avatar");

      res.json({ task: updatedTask });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Delete Task
taskRouter.delete(
  "/tasks/:taskId",
  isAuthenticated,
  checkTaskAccess(["manager", "member"]),
  async (req, res) => {
    try {
      await TaskModel.findByIdAndDelete(req.params.taskId);
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Create Column
taskRouter.post(
  "/project/:projectId/columns",
  isAuthenticated,
  checkProjectRole("manager"),
  async (req, res) => {
    try {
      const { title, accentColor, isDefault } = req.body;
      const project = req.project;

      const newColumn = {
        id: `col-${Date.now()}`,
        title,
        isDefault: !!isDefault,
        accentColor: accentColor || "#e2e8f0",
      };

      project.taskColumns.push(newColumn);
      await project.save();

      res.json({ columns: project.taskColumns });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

export default taskRouter;
