import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Router } from "express";
import { r2 } from "../config/r2.js";
import FileModel from "../schema/file.js";
import {
  isAuthenticated,
  checkProjectRole,
  checkWorkspaceRole,
} from "../middleware/checkWorkspaceRole.js";
import ProjectModel from "../schema/project.js";
import WorkspaceModel from "../schema/workspace.js";

const fileRouter = Router();

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;
const R2_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:2916",
  "https://flux.aisq.dev",
];

const isValidObjectId = (value) =>
  typeof value === "string" && OBJECT_ID_REGEX.test(value);

const handleServerError = (res, error, message) => {
  console.error(message, error);
  return res.status(500).json({ error: message });
};

const mapRequiredRolesToWorkspaceRoles = (requiredRoles) => {
  const mapped = new Set();

  if (requiredRoles.includes("manager")) {
    mapped.add("owner");
    mapped.add("admin");
  }

  if (requiredRoles.includes("member")) {
    mapped.add("owner");
    mapped.add("admin");
    mapped.add("member");
  }

  return mapped;
};

const ensureProjectOrWorkspaceAccess = async (req, res, next) => {
  const { projectId, workspaceId, scope } = req.body;

  if (scope === "workspace") {
    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId is required" });
    }

    req.params.workspaceId = workspaceId;
    return checkWorkspaceRole("owner", "admin", "member")(req, res, next);
  }

  if (scope === "project") {
    if (!isValidObjectId(projectId)) {
      return res.status(400).json({ error: "projectId is required" });
    }

    req.params.projectId = projectId;
    return checkProjectRole("manager", "member")(req, res, next);
  }

  if (isValidObjectId(projectId)) {
    req.params.projectId = projectId;
    return checkProjectRole("manager", "member")(req, res, next);
  }

  if (workspaceId) {
    req.params.workspaceId = workspaceId;
    return checkWorkspaceRole("owner", "admin", "member")(req, res, next);
  }

  return res.status(400).json({ error: "workspaceId is required" });
};

const checkFileAccess = (requiredRoles) => async (req, res, next) => {
  try {
    const file = await FileModel.findById(req.params.fileId);
    if (!file) return res.status(404).json({ error: "File not found" });

    if (!file.project) {
      const workspace = await WorkspaceModel.findById(file.workspace).populate(
        "members.role",
      );
      if (!workspace) {
        return res.status(404).json({ error: "Workspace not found" });
      }

      const workspaceMember = workspace.members.find(
        (m) => m.user.toString() === req.user._id.toString(),
      );
      const roleName = workspaceMember?.role?.name?.toLowerCase();

      const allowedWorkspaceRoles = mapRequiredRolesToWorkspaceRoles(requiredRoles);
      if (!roleName || !allowedWorkspaceRoles.has(roleName)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      req.file = file;
      req.fileProject = null;
      req.fileWorkspace = workspace;
      return next();
    }

    const project = await ProjectModel.findById(file.project).populate(
      "members.role",
    );
    if (!project) return res.status(404).json({ error: "Project not found" });

    const workspace = await WorkspaceModel.findById(project.workspace).populate(
      "members.role",
    );

    const wsMember = workspace?.members.find(
      (m) => m.user.toString() === req.user._id.toString(),
    );
    if (
      wsMember?.role &&
      ["owner", "admin"].includes(wsMember.role.name?.toLowerCase())
    ) {
      req.file = file;
      req.fileProject = project;
      return next();
    }

    const projMember = project.members.find(
      (m) => m.user.toString() === req.user._id.toString(),
    );
    if (
      !projMember?.role ||
      !requiredRoles.includes(projMember.role.name?.toLowerCase())
    ) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    req.file = file;
    req.fileProject = project;
    next();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

const registerUploadAndFolderRoutes = (router) => {
  router.post("/presign", isAuthenticated, async (req, res) => {
    const { fileName } = req.body;
    if (!fileName) {
      return res.status(400).json({ error: "Missing fileName" });
    }

    const presignedUrl = await getSignedUrl(
      r2,
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: fileName,
      }),
      { expiresIn: 3600 },
    );

    return res.json({ url: presignedUrl, path: fileName });
  });

  router.post(
    "/upload",
    isAuthenticated,
    ensureProjectOrWorkspaceAccess,
    async (req, res) => {
      try {
        const {
          filename,
          size,
          mimeType,
          url,
          thumbnail,
          workspaceId,
          projectId,
          parentId,
          metaData,
          scope,
        } = req.body;

        const resolvedWorkspaceId = req.project?.workspace || req.workspace?._id || workspaceId;
        const resolvedProjectId =
          scope === "workspace" ? null : req.project?._id || (isValidObjectId(projectId) ? projectId : null);

        const file = new FileModel({
          filename,
          size,
          mimeType,
          url,
          thumbnail,
          workspace: resolvedWorkspaceId,
          project: resolvedProjectId,
          parent: parentId || null,
          author: req.user._id,
          metaData: metaData || {},
          isFolder: false,
        });

        await file.save();
        return res.status(201).json({ file });
      } catch (error) {
        return handleServerError(res, error, "Failed to save file metadata");
      }
    },
  );

  router.post(
    "/folder",
    isAuthenticated,
    ensureProjectOrWorkspaceAccess,
    async (req, res) => {
      try {
        const { name, workspaceId, projectId, parentId, scope } = req.body;
        if (!name) {
          return res.status(400).json({ error: "Folder name is required" });
        }

        const resolvedWorkspaceId = req.project?.workspace || req.workspace?._id || workspaceId;
        const resolvedProjectId =
          scope === "workspace" ? null : req.project?._id || (isValidObjectId(projectId) ? projectId : null);

        const folder = new FileModel({
          filename: name,
          workspace: resolvedWorkspaceId,
          project: resolvedProjectId,
          parent: parentId || null,
          author: req.user._id,
          isFolder: true,
        });

        await folder.save();
        return res.status(201).json({ folder });
      } catch (error) {
        return handleServerError(res, error, "Failed to create folder");
      }
    },
  );
};

const registerProjectStorageRoutes = (router) => {
  router.get(
    "/project/:projectId",
    isAuthenticated,
    checkProjectRole("manager", "member", "viewer"),
    async (req, res) => {
      try {
        const { projectId } = req.params;
        const { parentId, includeTrash } = req.query;

        const query = {
          project: projectId,
          parent: parentId || null,
        };

        if (!includeTrash) {
          query.trashedAt = null;
        }

        const files = await FileModel.find(query)
          .populate("author", "name email avatar")
          .sort({ isFolder: -1, filename: 1 });

        return res.json({ files });
      } catch (error) {
        return handleServerError(res, error, "Failed to fetch files");
      }
    },
  );

  router.get(
    "/my-files/:projectId",
    isAuthenticated,
    checkProjectRole("manager", "member", "viewer"),
    async (req, res) => {
      try {
        const { projectId } = req.params;
        const files = await FileModel.find({
          project: projectId,
          author: req.user._id,
          trashedAt: null,
        })
          .populate("author", "name email avatar")
          .sort({ createdAt: -1 });

        return res.json({ files });
      } catch (error) {
        return handleServerError(res, error, "Failed to fetch files");
      }
    },
  );

  router.get(
    "/starred/:projectId",
    isAuthenticated,
    checkProjectRole("manager", "member", "viewer"),
    async (req, res) => {
      try {
        const { projectId } = req.params;
        const files = await FileModel.find({
          project: projectId,
          starred: true,
          trashedAt: null,
        })
          .populate("author", "name email avatar")
          .sort({ createdAt: -1 });

        return res.json({ files });
      } catch (error) {
        return handleServerError(res, error, "Failed to fetch starred files");
      }
    },
  );

  router.get(
    "/shared/:projectId",
    isAuthenticated,
    checkProjectRole("manager", "member", "viewer"),
    async (req, res) => {
      try {
        const { projectId } = req.params;
        const files = await FileModel.find({
          project: projectId,
          "sharedWith.user": req.user._id,
          trashedAt: null,
        })
          .populate("author", "name email avatar")
          .sort({ createdAt: -1 });

        return res.json({ files });
      } catch (error) {
        return handleServerError(res, error, "Failed to fetch shared files");
      }
    },
  );

  router.get(
    "/trash/:projectId",
    isAuthenticated,
    checkProjectRole("manager", "member"),
    async (req, res) => {
      try {
        const { projectId } = req.params;
        const files = await FileModel.find({
          project: projectId,
          trashedAt: { $ne: null },
        })
          .populate("author", "name email avatar")
          .sort({ trashedAt: -1 });

        return res.json({ files });
      } catch (error) {
        return handleServerError(res, error, "Failed to fetch trashed files");
      }
    },
  );
};

const registerFileActionRoutes = (router) => {
  router.put(
    "/:fileId/star",
    isAuthenticated,
    checkFileAccess(["manager", "member"]),
    async (req, res) => {
      try {
        const file = req.file;
        file.starred = !file.starred;
        await file.save();
        return res.json({ file });
      } catch (error) {
        return handleServerError(res, error, "Failed to toggle star");
      }
    },
  );

  router.delete(
    "/:fileId",
    isAuthenticated,
    checkFileAccess(["manager", "member"]),
    async (req, res) => {
      try {
        const file = req.file;
        file.trashedAt = new Date();
        await file.save();
        return res.json({ message: "File moved to trash", file });
      } catch (error) {
        return handleServerError(res, error, "Failed to move to trash");
      }
    },
  );

  router.put(
    "/:fileId/restore",
    isAuthenticated,
    checkFileAccess(["manager", "member"]),
    async (req, res) => {
      try {
        const file = req.file;
        file.trashedAt = null;
        await file.save();
        return res.json({ message: "File restored", file });
      } catch (error) {
        return handleServerError(res, error, "Failed to restore file");
      }
    },
  );

  router.delete(
    "/:fileId/permanent",
    isAuthenticated,
    checkFileAccess(["manager"]),
    async (req, res) => {
      try {
        const file = req.file;
        const { fileId } = req.params;

        if (!file.isFolder && file.url) {
          try {
            const key = file.url.split("/api/files/")[1];
            if (key) {
              await r2.send(
                new DeleteObjectCommand({
                  Bucket: process.env.R2_BUCKET_NAME,
                  Key: key,
                }),
              );
            }
          } catch (r2Error) {
            console.error("Failed to delete file from R2", r2Error);
          }
        }

        await FileModel.findByIdAndDelete(fileId);
        return res.json({ message: "File permanently deleted" });
      } catch (error) {
        return handleServerError(res, error, "Failed to permanently delete file");
      }
    },
  );

  router.put(
    "/:fileId/share",
    isAuthenticated,
    checkFileAccess(["manager", "member"]),
    async (req, res) => {
      try {
        const file = req.file;
        const { userId, permission } = req.body;

        if (!userId) {
          return res.status(400).json({ error: "Missing userId" });
        }

        const existingShare = file.sharedWith.find(
          (share) => share.user.toString() === userId,
        );

        if (existingShare) {
          existingShare.permission = permission || "view";
        } else {
          file.sharedWith.push({ user: userId, permission: permission || "view" });
        }

        await file.save();
        return res.json({ file });
      } catch (error) {
        return handleServerError(res, error, "Failed to share file");
      }
    },
  );

  router.put(
    "/:fileId/rename",
    isAuthenticated,
    checkFileAccess(["manager", "member"]),
    async (req, res) => {
      try {
        const file = req.file;
        const { name } = req.body;

        if (!name) {
          return res.status(400).json({ error: "Missing name" });
        }

        file.filename = name;
        await file.save();
        return res.json({ file });
      } catch (error) {
        return handleServerError(res, error, "Failed to rename file");
      }
    },
  );
};

const registerWorkspaceStorageRoutes = (router) => {
  router.get(
    "/workspace/:workspaceId/home",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    async (req, res) => {
      try {
        const { workspaceId } = req.params;
        const isPrivileged = ["owner", "admin"].includes(req.workspaceRole);

        const projectQuery = { workspace: req.workspace._id };
        if (!isPrivileged) {
          projectQuery["members.user"] = req.user._id;
        }

        const projects = await ProjectModel.find(projectQuery).select("_id name").lean();

        const projectStats = await Promise.all(
          projects.map(async (project) => {
            const stats = await FileModel.aggregate([
              {
                $match: {
                  project: project._id,
                  trashedAt: null,
                  isFolder: false,
                },
              },
              {
                $group: {
                  _id: null,
                  fileCount: { $sum: 1 },
                  totalSize: { $sum: { $ifNull: ["$size", 0] } },
                },
              },
            ]);

            return {
              _id: project._id,
              name: project.name,
              fileCount: stats[0]?.fileCount || 0,
              totalSize: stats[0]?.totalSize || 0,
            };
          }),
        );

        const workspaceFiles = await FileModel.find({
          workspace: workspaceId,
          project: null,
          parent: null,
          trashedAt: null,
        })
          .populate("author", "name email avatar")
          .sort({ isFolder: -1, filename: 1 });

        return res.json({ projects: projectStats, workspaceFiles });
      } catch (error) {
        return handleServerError(res, error, "Failed to fetch workspace home");
      }
    },
  );

  router.get(
    "/workspace/:workspaceId/all",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    async (req, res) => {
      try {
        const { workspaceId } = req.params;
        const { parentId } = req.query;
        const isPrivileged = ["owner", "admin"].includes(req.workspaceRole);

        let allowedProjectIds;
        if (!isPrivileged) {
          const memberProjects = await ProjectModel.find({
            workspace: req.workspace._id,
            "members.user": req.user._id,
          }).select("_id");
          allowedProjectIds = memberProjects.map((project) => project._id);
        }

        const query = {
          workspace: workspaceId,
          trashedAt: null,
          ...(allowedProjectIds ? { project: { $in: allowedProjectIds } } : {}),
          parent: parentId || null,
        };

        const files = await FileModel.find(query)
          .populate("author", "name email avatar")
          .populate("project", "name")
          .sort({ isFolder: -1, filename: 1 });

        return res.json({ files });
      } catch (error) {
        return handleServerError(res, error, "Failed to fetch files");
      }
    },
  );

  router.get(
    "/workspace/:workspaceId/my-files",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    async (req, res) => {
      try {
        const { workspaceId } = req.params;
        const { parentId } = req.query;
        const files = await FileModel.find({
          workspace: workspaceId,
          author: req.user._id,
          parent: parentId || null,
          trashedAt: null,
        })
          .populate("author", "name email avatar")
          .populate("project", "name")
          .sort({ createdAt: -1 });

        return res.json({ files });
      } catch (error) {
        return handleServerError(res, error, "Failed to fetch files");
      }
    },
  );

  router.get(
    "/workspace/:workspaceId/starred",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    async (req, res) => {
      try {
        const { workspaceId } = req.params;
        const isPrivileged = ["owner", "admin"].includes(req.workspaceRole);

        const files = await FileModel.find({
          workspace: workspaceId,
          starred: true,
          trashedAt: null,
          ...(isPrivileged ? {} : { author: req.user._id }),
        })
          .populate("author", "name email avatar")
          .populate("project", "name")
          .sort({ createdAt: -1 });

        return res.json({ files });
      } catch (error) {
        return handleServerError(res, error, "Failed to fetch starred files");
      }
    },
  );

  router.get(
    "/workspace/:workspaceId/shared",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    async (req, res) => {
      try {
        const { workspaceId } = req.params;
        const files = await FileModel.find({
          workspace: workspaceId,
          "sharedWith.user": req.user._id,
          trashedAt: null,
        })
          .populate("author", "name email avatar")
          .populate("project", "name")
          .sort({ createdAt: -1 });

        return res.json({ files });
      } catch (error) {
        return handleServerError(res, error, "Failed to fetch shared files");
      }
    },
  );

  router.get(
    "/workspace/:workspaceId/trash",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    async (req, res) => {
      try {
        const { workspaceId } = req.params;
        const isPrivileged = ["owner", "admin"].includes(req.workspaceRole);

        const files = await FileModel.find({
          workspace: workspaceId,
          trashedAt: { $ne: null },
          ...(isPrivileged ? {} : { author: req.user._id }),
        })
          .populate("author", "name email avatar")
          .populate("project", "name")
          .sort({ trashedAt: -1 });

        return res.json({ files });
      } catch (error) {
        return handleServerError(res, error, "Failed to fetch trashed files");
      }
    },
  );
};

const registerFileProxyRoute = (router) => {
  router.get(/^\/(.+)/, async (req, res) => {
    try {
      const filePath = req.params[0];
      if (!filePath) {
        return res.status(400).json({ error: "File path is required" });
      }

      const response = await r2.send(
        new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: filePath,
        }),
      );

      const origin = req.headers.origin;
      if (origin && R2_ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
      }

      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Content-Type", response.ContentType || "application/octet-stream");
      res.setHeader("Cache-Control", "public, max-age=31536000");

      response.Body.pipe(res);
    } catch (error) {
      if (error.name === "NoSuchKey") {
        return res.status(404).json({ error: "File not found" });
      }

      return handleServerError(res, error, "Failed to retrieve file");
    }
  });
};

registerUploadAndFolderRoutes(fileRouter);
registerProjectStorageRoutes(fileRouter);
registerFileActionRoutes(fileRouter);
registerWorkspaceStorageRoutes(fileRouter);
registerFileProxyRoute(fileRouter);

export default fileRouter;
