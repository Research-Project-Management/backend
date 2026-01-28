import { Router } from "express";
import PageModel from "../schema/page.js";
import ProjectModel from "../schema/project.js";
import WorkspaceModel from "../schema/workspace.js";
import {
  isAuthenticated,
  checkProjectRole,
  checkWorkspaceRole,
} from "../middleware/checkWorkspaceRole.js";

const pageRouter = Router();

// Middleware to check role via pageId
const checkPageAccess = (requiredRoles) => {
  return async (req, res, next) => {
    try {
      const page = await PageModel.findById(req.params.pageId);
      if (!page) return res.status(404).json({ error: "Page not found" });

      const project = await ProjectModel.findById(page.project);
      if (!project) return res.status(404).json({ error: "Project not found" });

      // Logic from checkProjectRole
       const workspace = await WorkspaceModel.findById(project.workspace);
       const workspaceMember = workspace.members.find(
        (m) => m.user.toString() === req.user._id.toString()
      );

      if (workspaceMember && ["owner", "admin"].includes(workspaceMember.role)) {
         req.page = page;
         req.project = project;
         return next();
      }

      const projectMember = project.members.find(
        (m) => m.user.toString() === req.user._id.toString()
      );

      if (!projectMember || !requiredRoles.includes(projectMember.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      req.page = page;
      req.project = project;
      next();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
};

// 0. Get all pages in a workspace
pageRouter.get(
  "/workspace/:id/pages",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    try {
      const { status, search } = req.query;
      
      // Find all projects in workspace first
      // Use req.workspace._id from middleware which resolves both ID and URL slug
      const projects = await ProjectModel.find({ workspace: req.workspace._id }).select("_id");
      const projectIds = projects.map(p => p._id);
      
      const query = { project: { $in: projectIds } };
      
      if (status && status !== "all") {
        query.status = status;
      }
      
      if (search) {
        query.title = { $regex: search, $options: "i" };
      }

      const pages = await PageModel.find(query)
        .populate("author", "name avatar")
        .populate("project", "name")
        .sort({ updatedAt: -1 });
        
      res.json({ pages });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);


// 1. Get all pages in a project
pageRouter.get(
  "/project/:projectId/pages",
  isAuthenticated,
  checkProjectRole("manager", "member", "viewer"),
  async (req, res) => {
    try {
      const { status, search } = req.query;
      const query = { project: req.params.projectId };
      
      if (status && status !== "all") {
        query.status = status;
      }
      
      if (search) {
        query.title = { $regex: search, $options: "i" };
      }

      const pages = await PageModel.find(query)
        .populate("author", "name avatar")
        .sort({ updatedAt: -1 });
        
      res.json({ pages });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// 2. Create a new page
pageRouter.post(
  "/project/:projectId/pages",
  isAuthenticated,
  checkProjectRole("manager", "member"), // Viewers cannot create
  async (req, res) => {
    try {
      const { title, content, status } = req.body;
      
      const newPage = new PageModel({
        title,
        content,
        status: status || "draft",
        project: req.params.projectId,
        author: req.user._id,
      });

      await newPage.save();
      await newPage.populate("author", "name avatar");
      
      res.status(201).json({ page: newPage });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// 3. Get single page details
pageRouter.get(
  "/pages/:pageId",
  isAuthenticated,
  checkPageAccess(["manager", "member", "viewer"]),
  async (req, res) => {
    try {
      // Increment views
      req.page.views += 1;
      req.page.lastAccessedAt = Date.now();
      await req.page.save();
      
      const page = await req.page.populate("author", "name avatar");
      res.json({ page });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// 4. Update a page
pageRouter.put(
  "/pages/:pageId",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const { title, content, status } = req.body;
      const page = req.page;

      if (title !== undefined) page.title = title;
      if (content !== undefined) page.content = content;
      if (status !== undefined) page.status = status;

      await page.save();
      res.json({ page });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// 5. Delete a page
pageRouter.delete(
  "/pages/:pageId",
  isAuthenticated,
  checkPageAccess(["manager"]), // Only managers can delete
  async (req, res) => {
    try {
      await PageModel.findByIdAndDelete(req.params.pageId);
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

export default pageRouter;
