import {
  S3Client,
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

/**
 * Middleware: verify the requesting user is a member of the file's project
 * (or a workspace owner/admin). Sets req.file and req.fileProject on success.
 */
const checkFileAccess = (requiredRoles) => async (req, res, next) => {
  try {
    const file = await FileModel.findById(req.params.fileId);
    if (!file) return res.status(404).json({ error: "File not found" });

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
    res.status(500).json({ error: err.message });
  }
};

const fileRouter = Router();

// Get presigned URL for upload
fileRouter.post("/presign", isAuthenticated, async (req, res) => {
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
    { expiresIn: 3600 }, // URL valid for 1 hour
  );
  res.json({ url: presignedUrl, path: fileName });
});

// Save file metadata after upload
fileRouter.post(
  "/upload",
  isAuthenticated,
  (req, res, next) => {
    req.params.projectId = req.body.projectId;
    next();
  },
  checkProjectRole("manager", "member"),
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
      } = req.body;

      if (!projectId) {
        return res.status(400).json({ error: "projectId is required" });
      }

      const file = new FileModel({
        filename,
        size,
        mimeType,
        url,
        thumbnail,
        workspace: workspaceId,
        project: projectId,
        parent: parentId || null,
        author: req.user._id,
        metaData: metaData || {},
        isFolder: false,
      });

      await file.save();
      res.status(201).json({ file });
    } catch (error) {
      console.error("Error saving file metadata:", error);
      res.status(500).json({ error: "Failed to save file metadata" });
    }
  },
);

// Create folder
fileRouter.post(
  "/folder",
  isAuthenticated,
  (req, res, next) => {
    req.params.projectId = req.body.projectId;
    next();
  },
  checkProjectRole("manager", "member"),
  async (req, res) => {
    try {
      const { name, workspaceId, projectId, parentId } = req.body;

      if (!name || !projectId) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const folder = new FileModel({
        filename: name,
        workspace: workspaceId,
        project: projectId,
        parent: parentId || null,
        author: req.user._id,
        isFolder: true,
      });

      await folder.save();
      res.status(201).json({ folder });
    } catch (error) {
      console.error("Error creating folder:", error);
      res.status(500).json({ error: "Failed to create folder" });
    }
  },
);

// List files in project or folder
fileRouter.get(
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

      // Exclude trashed files by default
      if (!includeTrash) {
        query.trashedAt = null;
      }

      const files = await FileModel.find(query)
        .populate("author", "name email avatar")
        .sort({ isFolder: -1, filename: 1 }); // Folders first, then alphabetically

      res.json({ files });
    } catch (error) {
      console.error("Error fetching files:", error);
      res.status(500).json({ error: "Failed to fetch files" });
    }
  },
);

// Get files by current user in project
fileRouter.get(
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

      res.json({ files });
    } catch (error) {
      console.error("Error fetching my files:", error);
      res.status(500).json({ error: "Failed to fetch files" });
    }
  },
);

// Get starred files in project
fileRouter.get(
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

      res.json({ files });
    } catch (error) {
      console.error("Error fetching starred files:", error);
      res.status(500).json({ error: "Failed to fetch starred files" });
    }
  },
);

// Get shared files in project
fileRouter.get(
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

      res.json({ files });
    } catch (error) {
      console.error("Error fetching shared files:", error);
      res.status(500).json({ error: "Failed to fetch shared files" });
    }
  },
);

// Get trashed files in project
fileRouter.get(
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

      res.json({ files });
    } catch (error) {
      console.error("Error fetching trashed files:", error);
      res.status(500).json({ error: "Failed to fetch trashed files" });
    }
  },
);

// Toggle star
fileRouter.put(
  "/:fileId/star",
  isAuthenticated,
  checkFileAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const file = req.file;

      file.starred = !file.starred;
      await file.save();

      res.json({ file });
    } catch (error) {
      console.error("Error toggling star:", error);
      res.status(500).json({ error: "Failed to toggle star" });
    }
  },
);

// Move to trash (soft delete)
fileRouter.delete(
  "/:fileId",
  isAuthenticated,
  checkFileAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const file = req.file;

      file.trashedAt = new Date();
      await file.save();

      res.json({ message: "File moved to trash", file });
    } catch (error) {
      console.error("Error moving to trash:", error);
      res.status(500).json({ error: "Failed to move to trash" });
    }
  },
);

// Restore from trash
fileRouter.put(
  "/:fileId/restore",
  isAuthenticated,
  checkFileAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const file = req.file;

      file.trashedAt = null;
      await file.save();

      res.json({ message: "File restored", file });
    } catch (error) {
      console.error("Error restoring file:", error);
      res.status(500).json({ error: "Failed to restore file" });
    }
  },
);

// Permanent delete (remove from R2 and database)
fileRouter.delete(
  "/:fileId/permanent",
  isAuthenticated,
  checkFileAccess(["manager"]),
  async (req, res) => {
    try {
      const file = req.file;
      const { fileId } = req.params;

      // Delete from R2 if it's a file (not a folder)
      if (!file.isFolder && file.url) {
        try {
          // Extract the key from the URL
          const urlParts = file.url.split("/api/files/");
          const key = urlParts[1];

          if (key) {
            const deleteCommand = new DeleteObjectCommand({
              Bucket: process.env.R2_BUCKET_NAME,
              Key: key,
            });
            await r2.send(deleteCommand);
          }
        } catch (r2Error) {
          console.error("Error deleting from R2:", r2Error);
          // Continue with database deletion even if R2 deletion fails
        }
      }

      // Delete from database
      await FileModel.findByIdAndDelete(fileId);

      res.json({ message: "File permanently deleted" });
    } catch (error) {
      console.error("Error permanently deleting file:", error);
      res.status(500).json({ error: "Failed to permanently delete file" });
    }
  },
);

// Share file
fileRouter.put(
  "/:fileId/share",
  isAuthenticated,
  checkFileAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const file = req.file;
      const { fileId } = req.params;
      const { userId, permission } = req.body;

      if (!userId) {
        return res.status(400).json({ error: "Missing userId" });
      }

      // Check if already shared with this user
      const existingShare = file.sharedWith.find(
        (share) => share.user.toString() === userId,
      );

      if (existingShare) {
        existingShare.permission = permission || "view";
      } else {
        file.sharedWith.push({
          user: userId,
          permission: permission || "view",
        });
      }

      await file.save();
      res.json({ file });
    } catch (error) {
      console.error("Error sharing file:", error);
      res.status(500).json({ error: "Failed to share file" });
    }
  },
);

// Rename file or folder
fileRouter.put(
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

      res.json({ file });
    } catch (error) {
      console.error("Error renaming file:", error);
      res.status(500).json({ error: "Failed to rename file" });
    }
  },
);

// Workspace-level aggregation endpoints
// Get all files from all projects in workspace
fileRouter.get(
  "/workspace/:workspaceId/all",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    try {
      const { workspaceId } = req.params;
      const { parentId } = req.query;
      const isPrivileged = ["owner", "admin"].includes(req.workspaceRole);

      // For members, restrict to projects they belong to
      let allowedProjectIds;
      if (!isPrivileged) {
        const memberProjects = await ProjectModel.find({
          workspace: req.workspace._id,
          "members.user": req.user._id,
        }).select("_id");
        allowedProjectIds = memberProjects.map((p) => p._id);
      }

      const query = {
        workspace: workspaceId,
        trashedAt: null,
        ...(allowedProjectIds ? { project: { $in: allowedProjectIds } } : {}),
      };

      // If parentId is provided, filter by it; otherwise get root level
      if (parentId) {
        query.parent = parentId;
      } else {
        query.parent = null;
      }

      const files = await FileModel.find(query)
        .populate("author", "name email avatar")
        .populate("project", "name")
        .sort({ isFolder: -1, filename: 1 });

      res.json({ files });
    } catch (error) {
      console.error("Error fetching workspace files:", error);
      res.status(500).json({ error: "Failed to fetch files" });
    }
  },
);

// Get all files by current user from all projects in workspace
fileRouter.get(
  "/workspace/:workspaceId/my-files",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    try {
      const { workspaceId } = req.params;

      const files = await FileModel.find({
        workspace: workspaceId,
        author: req.user._id,
        trashedAt: null,
      })
        .populate("author", "name email avatar")
        .populate("project", "name")
        .sort({ createdAt: -1 });

      res.json({ files });
    } catch (error) {
      console.error("Error fetching my files:", error);
      res.status(500).json({ error: "Failed to fetch files" });
    }
  },
);

// Get all starred files from all projects in workspace
fileRouter.get(
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
        // Members only see their own starred files
        ...(isPrivileged ? {} : { author: req.user._id }),
      })
        .populate("author", "name email avatar")
        .populate("project", "name")
        .sort({ createdAt: -1 });

      res.json({ files });
    } catch (error) {
      console.error("Error fetching starred files:", error);
      res.status(500).json({ error: "Failed to fetch starred files" });
    }
  },
);

// Get all shared files from all projects in workspace
fileRouter.get(
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

      res.json({ files });
    } catch (error) {
      console.error("Error fetching shared files:", error);
      res.status(500).json({ error: "Failed to fetch shared files" });
    }
  },
);

// Get all trashed files from all projects in workspace
fileRouter.get(
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
        // Members only see their own trashed files
        ...(isPrivileged ? {} : { author: req.user._id }),
      })
        .populate("author", "name email avatar")
        .populate("project", "name")
        .sort({ trashedAt: -1 });

      res.json({ files });
    } catch (error) {
      console.error("Error fetching trashed files:", error);
      res.status(500).json({ error: "Failed to fetch trashed files" });
    }
  },
);

// Serve files from R2 via backend proxy - must be after all other routes
fileRouter.get(/^\/(.+)/, async (req, res) => {
  try {
    // Get file path from regex match
    const filePath = req.params[0];

    if (!filePath) {
      return res.status(400).json({ error: "File path is required" });
    }

    // Get file from R2
    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: filePath,
    });

    const response = await r2.send(command);

    // Set CORS headers for cross-origin access
    res.setHeader("Access-Control-Allow-Origin", "http://localhost:5173");
    res.setHeader("Access-Control-Allow-Origin", "https://flux.aisq.dev");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

    // Set appropriate headers
    res.setHeader(
      "Content-Type",
      response.ContentType || "application/octet-stream",
    );
    res.setHeader("Cache-Control", "public, max-age=31536000"); // Cache for 1 year

    // Stream the file to response
    response.Body.pipe(res);
  } catch (error) {
    console.error("Error serving file from R2:", error);
    if (error.name === "NoSuchKey") {
      return res.status(404).json({ error: "File not found" });
    }
    res.status(500).json({ error: "Failed to retrieve file" });
  }
});

export default fileRouter;
