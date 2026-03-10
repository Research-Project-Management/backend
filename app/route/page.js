import { Router } from "express";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import PageModel from "../schema/page.js";
import PageAssetModel from "../schema/pageAsset.js";
import PageVersionModel from "../schema/pageVersion.js";
import ProjectModel from "../schema/project.js";
import WorkspaceModel from "../schema/workspace.js";
import { r2 } from "../config/r2.js";
import {
  isAuthenticated,
  checkProjectRole,
  checkWorkspaceRole,
} from "../middleware/checkWorkspaceRole.js";
import { getIO } from "../libs/socket.js";

const pageRouter = Router();

// ── Compiler file-sync helpers ────────────────────────────────────────────────
// These keep the Flux-Latex-Compiler's persistent project folder in sync with
// MongoDB so that compile requests only need to send the current editor source.

const LATEX_URL = process.env.LATEX_URL || "http://localhost:8001";

/** Derive the compiler project folder key from a page document. */
function projectFolderKey(page) {
  return page.parentPage ? page.parentPage.toString() : page._id.toString();
}

/** Encodes text as base64 (UTF-8). */
function textToBase64(text) {
  return Buffer.from(text ?? "", "utf8").toString("base64");
}

/**
 * Fire-and-forget: write a file to the compiler's persistent project folder.
 * @param {string} folderId  - MongoDB ObjectId string (the root page ID).
 * @param {string} filename  - Destination filename inside the project folder.
 * @param {string} base64    - Base64-encoded file content.
 */
function syncFileToCompiler(folderId, filename, base64) {
  fetch(
    `${LATEX_URL}/projects/${folderId}/files/${encodeURIComponent(filename)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: base64 }),
    },
  ).catch((err) =>
    console.warn(`[sync] PUT ${folderId}/${filename} failed:`, err.message),
  );
}

/**
 * Fire-and-forget: remove a file from the compiler's persistent project folder.
 */
function deleteFileFromCompiler(folderId, filename) {
  fetch(
    `${LATEX_URL}/projects/${folderId}/files/${encodeURIComponent(filename)}`,
    { method: "DELETE" },
  ).catch((err) =>
    console.warn(`[sync] DELETE ${folderId}/${filename} failed:`, err.message),
  );
}

/**
 * Fire-and-forget: remove the entire project folder from the compiler.
 */
function deleteProjectFromCompiler(folderId) {
  fetch(`${LATEX_URL}/projects/${folderId}`, { method: "DELETE" }).catch(
    (err) =>
      console.warn(`[sync] DELETE project ${folderId} failed:`, err.message),
  );
}

// ── Version control helpers ───────────────────────────────────────────────────

const TWO_MINUTES = 2 * 60 * 1000;

/**
 * Auto-save: create a new version entry or update the most recent auto_save
 * within the last 2 minutes (sliding-window deduplication).
 * Fire-and-forget — does NOT block the response.
 */
async function recordAutoVersion(pageId, page, userId) {
  try {
    const folderId = page.parentPage
      ? page.parentPage.toString()
      : page._id.toString();
    const texName = page.parentPage
      ? page.title.endsWith(".tex")
        ? page.title
        : `${page.title}.tex`
      : "main.tex";
    const recent = await PageVersionModel.findOne({
      page: pageId,
      savedBy: userId,
      eventType: "auto_save",
      createdAt: { $gte: new Date(Date.now() - TWO_MINUTES) },
    });
    if (recent) {
      recent.content = page.content ?? "";
      recent.title = page.title ?? "";
      recent.fileName = texName;
      await recent.save();
    } else {
      await PageVersionModel.create({
        page: pageId,
        projectPageId: folderId,
        content: page.content ?? "",
        title: page.title ?? "",
        label: "",
        savedBy: userId,
        eventType: "auto_save",
        fileName: texName,
      });
    }
  } catch (err) {
    console.warn("[version] auto-save failed:", err.message);
  }
}

/**
 * Record a lifecycle event (file/asset created or deleted) under the project.
 * Fire-and-forget.
 */
async function recordLifecycleEvent(rootPageId, userId, eventType, fileName) {
  try {
    await PageVersionModel.create({
      page: rootPageId,
      projectPageId: rootPageId,
      content: "",
      title: "",
      label: "",
      savedBy: userId,
      eventType,
      fileName,
    });
  } catch (err) {
    console.warn("[version] lifecycle event failed:", err.message);
  }
}

// Middleware to check role via pageId
const checkPageAccess = (requiredRoles) => {
  return async (req, res, next) => {
    try {
      const page = await PageModel.findById(req.params.pageId);
      if (!page) return res.status(404).json({ error: "Page not found" });

      const project = await ProjectModel.findById(page.project);
      if (!project) return res.status(404).json({ error: "Project not found" });

      // Logic from checkProjectRole
      const workspace = await WorkspaceModel.findById(
        project.workspace,
      ).populate("members.role");
      const workspaceMember = workspace.members.find(
        (m) => m.user.toString() === req.user._id.toString(),
      );

      if (
        workspaceMember &&
        workspaceMember.role &&
        ["owner", "admin"].includes(workspaceMember.role.name?.toLowerCase())
      ) {
        req.page = page;
        req.project = project;
        return next();
      }

      const populatedProject = await ProjectModel.findById(
        project._id,
      ).populate("members.role");
      const projectMember = populatedProject.members.find(
        (m) => m.user.toString() === req.user._id.toString(),
      );

      if (
        !projectMember ||
        !projectMember.role ||
        !requiredRoles.includes(projectMember.role.name?.toLowerCase())
      ) {
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

// 0. Get all pages in a workspace (top-level only)
pageRouter.get(
  "/workspace/:id/pages",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    try {
      const { status, search } = req.query;

      const projects = await ProjectModel.find({
        workspace: req.workspace._id,
      }).select("_id");
      const projectIds = projects.map((p) => p._id);

      // Only top-level pages (not child files of a page-project)
      const query = { project: { $in: projectIds }, parentPage: null };

      if (status && status !== "all") query.status = status;
      if (search) query.title = { $regex: search, $options: "i" };

      const pages = await PageModel.find(query)
        .populate("author", "name avatar")
        .populate("project", "name")
        .populate("mainFile", "title")
        .sort({ updatedAt: -1 });

      res.json({ pages });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// 1. Get all pages in a project (top-level only)
pageRouter.get(
  "/project/:projectId/pages",
  isAuthenticated,
  checkProjectRole("manager", "member", "viewer"),
  async (req, res) => {
    try {
      const { status, search } = req.query;
      // Only top-level pages (page-projects), not child files
      const query = { project: req.params.projectId, parentPage: null };

      if (status && status !== "all") query.status = status;
      if (search) query.title = { $regex: search, $options: "i" };

      const pages = await PageModel.find(query)
        .populate("author", "name avatar")
        .populate("mainFile", "title")
        .sort({ updatedAt: -1 });

      res.json({ pages });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// 2. Create a new page-project (top-level) + auto-create main.tex child file
pageRouter.post(
  "/project/:projectId/pages",
  isAuthenticated,
  checkProjectRole("manager", "member"),
  async (req, res) => {
    try {
      const { title, content, status } = req.body;

      // Create the top-level page container (no content itself)
      const newPage = new PageModel({
        title,
        status: status || "draft",
        project: req.params.projectId,
        author: req.user._id,
        parentPage: null,
      });
      await newPage.save();

      // Auto-create the default main.tex file inside the page-project
      const mainFile = new PageModel({
        title: "main.tex",
        content: content ?? null,
        status: status || "draft",
        project: req.params.projectId,
        author: req.user._id,
        parentPage: newPage._id,
      });
      await mainFile.save();

      // Set mainFile on the page container
      newPage.mainFile = mainFile._id;
      await newPage.save();

      await newPage.populate("author", "name avatar");
      await newPage.populate("mainFile", "title");

      getIO()
        ?.to(`project:${req.params.projectId}`)
        .emit("page:created", { page: newPage });
      res.status(201).json({ page: newPage, mainFile });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// 3. Get single page details
pageRouter.get(
  "/pages/:pageId",
  isAuthenticated,
  checkPageAccess(["manager", "member", "viewer"]),
  async (req, res) => {
    try {
      req.page.views += 1;
      req.page.lastAccessedAt = Date.now();
      await req.page.save();

      const page = await PageModel.findById(req.page._id)
        .populate("author", "name avatar")
        .populate("mainFile", "title")
        .populate({
          path: "project",
          select: "name",
          populate: { path: "workspace", select: "url" },
        });
      res.json({ page });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// 4. Update a page (title / content / status)
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

      // Broadcast metadata changes (not the full content) to collaborators
      getIO()
        ?.to(`page:${req.params.pageId}`)
        .emit("page:updated", {
          pageId: req.params.pageId,
          title: title !== undefined ? page.title : undefined,
          status: status !== undefined ? page.status : undefined,
        });

      // Sync tex content to the compiler's project folder (fire-and-forget).
      // Root pages are always stored as "main.tex"; child files use their title.
      if (content !== undefined) {
        const folderId = projectFolderKey(page);
        const texName = page.parentPage
          ? page.title.endsWith(".tex")
            ? page.title
            : `${page.title}.tex`
          : "main.tex";
        syncFileToCompiler(folderId, texName, textToBase64(content));
        // Record auto-version (fire-and-forget, non-blocking).
        recordAutoVersion(req.params.pageId, page, req.user._id);
      }

      res.json({ page });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// 5. Delete a page (and its child files if top-level)
pageRouter.delete(
  "/pages/:pageId",
  isAuthenticated,
  checkPageAccess(["manager"]),
  async (req, res) => {
    try {
      // If it's a top-level page, also delete all child files
      await PageModel.deleteMany({ parentPage: req.params.pageId });
      await PageModel.findByIdAndDelete(req.params.pageId);
      getIO()
        ?.to(`project:${req.page.project}`)
        .emit("page:deleted", { pageId: req.params.pageId });
      if (!req.page.parentPage) {
        // Deleting a root page — remove the entire compiler project folder.
        deleteProjectFromCompiler(req.params.pageId);
      } else {
        // Deleting a child file — record lifecycle event under its parent project.
        const texName = req.page.title.endsWith(".tex")
          ? req.page.title
          : `${req.page.title}.tex`;
        recordLifecycleEvent(
          req.page.parentPage.toString(),
          req.user._id,
          "file_deleted",
          texName,
        );
      }
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// 6. Get child files of a page-project
pageRouter.get(
  "/pages/:pageId/files",
  isAuthenticated,
  checkPageAccess(["manager", "member", "viewer"]),
  async (req, res) => {
    try {
      const files = await PageModel.find({ parentPage: req.params.pageId })
        .select("_id title updatedAt")
        .sort({ createdAt: 1 });
      res.json({ files });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// 7. Create a child file inside a page-project
pageRouter.post(
  "/pages/:pageId/files",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const { title, content } = req.body;
      const parentPage = req.page;

      const file = new PageModel({
        title,
        content: content ?? null,
        status: parentPage.status,
        project: parentPage.project,
        author: req.user._id,
        parentPage: parentPage._id,
      });
      await file.save();

      // Sync new child file's content to the compiler project folder.
      const texName = title.endsWith(".tex") ? title : `${title}.tex`;
      syncFileToCompiler(
        parentPage._id.toString(),
        texName,
        textToBase64(content ?? ""),
      );
      // Record lifecycle event.
      recordLifecycleEvent(
        req.params.pageId,
        req.user._id,
        "file_created",
        texName,
      );

      getIO()?.to(`page:${req.params.pageId}`).emit("file:created", { file });
      res.status(201).json({ file });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// 9. Save a PDF thumbnail — uploads JPEG to R2, stores the proxy URL in MongoDB
pageRouter.put(
  "/pages/:pageId/thumbnail",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      // dataUrl is raw base64 (no "data:...;base64," prefix)
      const { dataUrl } = req.body;
      if (!dataUrl)
        return res.status(400).json({ error: "dataUrl is required" });

      const key = `thumbnails/${req.params.pageId}.jpg`;
      const buffer = Buffer.from(dataUrl, "base64");

      await r2.send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key,
          Body: buffer,
          ContentType: "image/jpeg",
          CacheControl: "public, max-age=31536000",
        }),
      );

      // Build URL via the existing /api/files/* proxy.
      // trust proxy = 1 is set, so req.protocol / host resolve correctly behind nginx/Cloudflare.
      const thumbnailUrl = `${req.protocol}://${req.get("host")}/api/files/${key}`;

      req.page.pdfThumbnail = thumbnailUrl;
      await req.page.save();

      res.json({ pdfThumbnail: thumbnailUrl });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// 8. Set the mainFile for a page-project
pageRouter.put(
  "/pages/:pageId/main-file",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const { fileId } = req.body;
      if (!fileId) return res.status(400).json({ error: "fileId is required" });

      // Ensure the file actually belongs to this page
      const file = await PageModel.findOne({
        _id: fileId,
        parentPage: req.params.pageId,
      });
      if (!file)
        return res.status(404).json({ error: "File not found in this page" });

      req.page.mainFile = file._id;
      await req.page.save();

      const updated = await PageModel.findById(req.page._id).populate(
        "mainFile",
        "title",
      );
      res.json({ page: updated });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// 10. List assets for a page-project (name/meta only, no binary data)
pageRouter.get(
  "/pages/:pageId/assets",
  isAuthenticated,
  checkPageAccess(["manager", "member", "viewer"]),
  async (req, res) => {
    try {
      const assets = await PageAssetModel.find({
        parentPage: req.params.pageId,
      })
        .select("_id name mimeType size createdAt")
        .sort({ createdAt: 1 });
      res.json({ assets });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// 11. Upload an asset (image / binary file) — client sends JSON { name, mimeType, data (base64) }
pageRouter.post(
  "/pages/:pageId/assets",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const { name, mimeType, data } = req.body;
      if (!name || !data)
        return res.status(400).json({ error: "name and data are required" });

      // Guard against oversized payloads (max 10 MB decoded)
      const sizeBytes = Buffer.from(data, "base64").length;
      if (sizeBytes > 10 * 1024 * 1024)
        return res.status(413).json({ error: "Asset too large (max 10 MB)" });

      const asset = new PageAssetModel({
        name,
        mimeType: mimeType || "application/octet-stream",
        size: sizeBytes,
        data,
        parentPage: req.params.pageId,
        project: req.page.project,
        author: req.user._id,
      });
      await asset.save();

      // Sync the asset to the compiler's project folder (fire-and-forget).
      syncFileToCompiler(req.params.pageId, name, data);
      // Record lifecycle event.
      recordLifecycleEvent(
        req.params.pageId,
        req.user._id,
        "asset_uploaded",
        name,
      );

      res.status(201).json({
        asset: {
          _id: asset._id,
          name: asset.name,
          mimeType: asset.mimeType,
          size: asset.size,
          createdAt: asset.createdAt,
        },
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// 12. Get asset binary data (for image preview)
pageRouter.get(
  "/pages/:pageId/assets/:assetId/data",
  isAuthenticated,
  checkPageAccess(["manager", "member", "viewer"]),
  async (req, res) => {
    try {
      const asset = await PageAssetModel.findOne({
        _id: req.params.assetId,
        parentPage: req.params.pageId,
      }).select("name mimeType data");
      if (!asset) return res.status(404).json({ error: "Asset not found" });
      res.json({
        name: asset.name,
        mimeType: asset.mimeType,
        data: asset.data,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// 13. Delete an asset from a page-project
pageRouter.delete(
  "/pages/:pageId/assets/:assetId",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const asset = await PageAssetModel.findOne({
        _id: req.params.assetId,
        parentPage: req.params.pageId,
      });
      if (!asset) return res.status(404).json({ error: "Asset not found" });
      await asset.deleteOne();
      // Remove from the compiler's project folder (fire-and-forget).
      deleteFileFromCompiler(req.params.pageId, asset.name);
      // Record lifecycle event.
      recordLifecycleEvent(
        req.params.pageId,
        req.user._id,
        "asset_deleted",
        asset.name,
      );
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// ── Version control ──────────────────────────────────────────────────────

// List versions for a page (metadata only)
pageRouter.get(
  "/pages/:pageId/versions",
  isAuthenticated,
  checkPageAccess(["manager", "member", "viewer"]),
  async (req, res) => {
    try {
      const versions = await PageVersionModel.find({
        page: req.params.pageId,
        eventType: "manual_save",
      })
        .select("_id title label fileName savedBy createdAt")
        .populate("savedBy", "name avatar")
        .sort({ createdAt: -1 })
        .limit(50);
      res.json({ versions });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Save current page content as a new version
pageRouter.post(
  "/pages/:pageId/versions",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const page = await PageModel.findById(req.params.pageId).select(
        "content title parentPage",
      );
      if (!page) return res.status(404).json({ error: "Page not found" });

      const { label = "" } = req.body;
      const projectPageId = page.parentPage ?? page._id;
      const texName = page.parentPage
        ? page.title.endsWith(".tex")
          ? page.title
          : `${page.title}.tex`
        : "main.tex";
      const version = await PageVersionModel.create({
        page: req.params.pageId,
        projectPageId,
        content: page.content ?? "",
        title: page.title,
        label,
        savedBy: req.user._id,
        eventType: "manual_save",
        fileName: texName,
      });
      await version.populate("savedBy", "name avatar");
      res.status(201).json({ version });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Restore a version
pageRouter.post(
  "/pages/:pageId/versions/:versionId/restore",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const version = await PageVersionModel.findOne({
        _id: req.params.versionId,
        page: req.params.pageId,
      });
      if (!version) return res.status(404).json({ error: "Version not found" });

      const page = await PageModel.findByIdAndUpdate(
        req.params.pageId,
        { content: version.content },
        { new: true },
      ).select("_id title content");
      res.json({ page });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Delete a version
pageRouter.delete(
  "/pages/:pageId/versions/:versionId",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const version = await PageVersionModel.findOneAndDelete({
        _id: req.params.versionId,
        page: req.params.pageId,
      });
      if (!version) return res.status(404).json({ error: "Version not found" });
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// ── Project history endpoints ─────────────────────────────────────────────────

// GET /pages/:rootPageId/history — project-level event timeline
pageRouter.get(
  "/pages/:pageId/history",
  isAuthenticated,
  checkPageAccess(["manager", "member", "viewer"]),
  async (req, res) => {
    try {
      const events = await PageVersionModel.find({
        projectPageId: req.params.pageId,
        eventType: {
          $in: [
            "manual_save",
            "file_created",
            "file_deleted",
            "asset_uploaded",
            "asset_deleted",
          ],
        },
      })
        .select("_id eventType title label fileName savedBy createdAt page")
        .populate("savedBy", "name avatar")
        .sort({ createdAt: -1 })
        .limit(200);
      res.json({ events });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// POST /pages/:rootPageId/history/:eventId/restore — restore all project files to snapshot
pageRouter.post(
  "/pages/:pageId/history/:eventId/restore",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const targetEvent = await PageVersionModel.findOne({
        _id: req.params.eventId,
        projectPageId: req.params.pageId,
      });
      if (!targetEvent)
        return res.status(404).json({ error: "Event not found" });

      const T = targetEvent.createdAt;
      const folderId = req.params.pageId;

      // Fetch all files in the project (root page + child files).
      const [rootPage, childFiles] = await Promise.all([
        PageModel.findById(folderId).select("_id title content parentPage"),
        PageModel.find({ parentPage: folderId }).select(
          "_id title content parentPage",
        ),
      ]);
      if (!rootPage)
        return res.status(404).json({ error: "Project not found" });

      const restored = [];
      for (const p of [rootPage, ...childFiles]) {
        // Find the most recent content snapshot at or before T.
        const snapshot = await PageVersionModel.findOne({
          page: p._id,
          eventType: { $in: ["manual_save", "auto_save"] },
          createdAt: { $lte: T },
        }).sort({ createdAt: -1 });

        if (snapshot) {
          await PageModel.findByIdAndUpdate(p._id, {
            content: snapshot.content,
          });
          const texName = p.parentPage
            ? p.title.endsWith(".tex")
              ? p.title
              : `${p.title}.tex`
            : "main.tex";
          syncFileToCompiler(
            folderId,
            texName,
            textToBase64(snapshot.content ?? ""),
          );
          restored.push({
            pageId: p._id.toString(),
            title: p.title,
            content: snapshot.content ?? "",
          });
        }
      }

      res.json({ restored, restoredAt: T });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// ── Version control (per-file) ────────────────────────────────────────────────

export default pageRouter;
