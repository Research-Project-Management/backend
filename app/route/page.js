import { Router } from "express";
import {
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import PageModel from "../schema/page.js";
import FileModel from "../schema/file.js";
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
import {
  LATEX_URL,
  textToBase64,
  syncFileToCompiler,
  syncFileToCompilerReliable,
  deleteFileFromCompiler,
  deleteFileFromCompilerReliable,
  deleteProjectFromCompiler,
  deleteProjectFromCompilerReliable,
  buildRelativePath,
  bulkSyncToCompiler,
} from "../libs/compiler-sync.js";

const pageRouter = Router();

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

// ── Derive compiler folder key ────────────────────────────────────────────────

/** Root page ID = compiler project folder ID. */
function projectFolderKey(page) {
  return page.parentPage ? page.parentPage.toString() : page._id.toString();
}

/**
 * Known non-.tex LaTeX-related extensions that should be preserved as-is.
 * Files with these extensions are stored verbatim in the compiler project folder.
 */
const LATEX_EXTENSIONS = new Set([".tex", ".bib", ".cls", ".sty", ".bst", ".bbx", ".cbx", ".ldf", ".ist"]);

/**
 * Derive the filename to use in the compiler project folder for a page doc.
 * - Root page (no parentPage) → always "main.tex"
 * - Child page with a recognised LaTeX extension → use as-is
 * - Child page with no recognised extension → append ".tex"
 */
function pageTexName(page) {
  if (!page.parentPage) return "main.tex";
  const dotIdx = page.title.lastIndexOf(".");
  if (dotIdx > 0) {
    const ext = page.title.slice(dotIdx).toLowerCase();
    if (LATEX_EXTENSIONS.has(ext)) return page.title;
  }
  return `${page.title}.tex`;
}

// ── Access middleware ─────────────────────────────────────────────────────────

const checkPageAccess = (requiredRoles) => {
  return async (req, res, next) => {
    try {
      const page = await PageModel.findById(req.params.pageId);
      if (!page) return res.status(404).json({ error: "Page not found" });

      const project = await ProjectModel.findById(page.project);
      if (!project) return res.status(404).json({ error: "Project not found" });

      const workspace = await WorkspaceModel.findById(
        project.workspace,
      ).populate("members.role");
      const workspaceMember = workspace.members.find(
        (m) => m.user.toString() === req.user._id.toString(),
      );

      if (
        workspaceMember?.role &&
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
        !projectMember?.role ||
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

// ── Routes ────────────────────────────────────────────────────────────────────

// 0. Get all pages in a workspace (top-level only)
pageRouter.get(
  "/workspace/:id/pages",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    try {
      const { status, search } = req.query;
      const isPrivileged = ["owner", "admin"].includes(req.workspaceRole);
      const projectQuery = { workspace: req.workspace._id };
      if (!isPrivileged) projectQuery["members.user"] = req.user._id;

      const projects = await ProjectModel.find(projectQuery).select("_id");
      const projectIds = projects.map((p) => p._id);
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

      console.log("[page.js] Creating new page:", { projectId: req.params.projectId, title });

      const newPage = new PageModel({
        title,
        status: status || "draft",
        project: req.params.projectId,
        author: req.user._id,
        parentPage: null,
      });
      await newPage.save();
      console.log("[page.js] New page created:", { _id: newPage._id.toString(), title: newPage.title });

      const mainFile = new PageModel({
        title: "main.tex",
        content: content || null,
        status: status || "draft",
        project: req.params.projectId,
        author: req.user._id,
        parentPage: newPage._id,
      });
      await mainFile.save();
      console.log("[page.js] Main file created:", { _id: mainFile._id.toString(), title: mainFile.title });

      newPage.mainFile = mainFile._id;
      await newPage.save();

      // Seed the compiler project folder with the main file content.
      if (content) {
        await syncFileToCompilerReliable(newPage._id.toString(), "main.tex", textToBase64(content));
        console.log("[page.js] Synced to compiler:", newPage._id.toString());
      }

      await newPage.populate("author", "name avatar");
      await mainFile.populate("author", "name avatar");

      console.log("[page.js] Returning response:", {
        page: { _id: newPage._id.toString(), title: newPage.title },
        mainFile: { _id: mainFile._id.toString(), title: mainFile.title }
      });

      getIO()
        ?.to(`project:${req.params.projectId}`)
        .emit("page:created", { page: newPage, mainFile });

      res.status(201).json({ page: newPage, mainFile });
    } catch (error) {
      console.error("[page.js] Create page error:", error);
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
        .populate("mainFile")
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
      const { title, content, status, _oldTitle } = req.body;
      const page = req.page;

      if (title !== undefined) page.title = title;
      if (content !== undefined) page.content = content;
      if (status !== undefined) page.status = status;

      await page.save();

      // Broadcast metadata changes (not the full content) to collaborators.
      getIO()
        ?.to(`page:${req.params.pageId}`)
        .emit("page:updated", {
          pageId: req.params.pageId,
          title: title !== undefined ? page.title : undefined,
          status: status !== undefined ? page.status : undefined,
        });

      // ── Compiler sync ──────────────────────────────────────────────────────
      const folderId = projectFolderKey(page);
      const newTexName = pageTexName(page);

      if (content !== undefined) {
        // Content changed — sync the updated source.
        await syncFileToCompilerReliable(folderId, newTexName, textToBase64(content));
        // Record auto-version (fire-and-forget).
        recordAutoVersion(req.params.pageId, page, req.user._id);
      }

      if (
        title !== undefined &&
        content === undefined &&
        page.parentPage &&
        _oldTitle &&
        _oldTitle !== page.title
      ) {
        // Title-only change on a child file → rename in compiler:
        // 1. Delete the old filename.
        const oldTexName = _oldTitle.endsWith(".tex")
          ? _oldTitle
          : `${_oldTitle}.tex`;
        await deleteFileFromCompilerReliable(folderId, oldTexName);
        // 2. Re-upload content under the new filename.
        if (page.content) {
          await syncFileToCompilerReliable(folderId, newTexName, textToBase64(page.content));
        }
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
      await PageModel.deleteMany({ parentPage: req.params.pageId });
      await PageModel.findByIdAndDelete(req.params.pageId);

      getIO()
        ?.to(`project:${req.page.project}`)
        .emit("page:deleted", { pageId: req.params.pageId });

      if (!req.page.parentPage) {
        // Root page deleted — remove entire compiler project folder.
        deleteProjectFromCompilerReliable(req.params.pageId).catch((err) =>
          console.warn("[compiler-sync] delete project failed:", err.message),
        );
      } else {
        // Child file deleted — remove just that file from compiler.
        const texName = pageTexName(req.page);
        const folderId = req.page.parentPage.toString();
        await deleteFileFromCompilerReliable(folderId, texName);
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

      const texName = title.endsWith(".tex") ? title : `${title}.tex`;
      await syncFileToCompilerReliable(
        parentPage._id.toString(),
        texName,
        textToBase64(content ?? ""),
      );
      recordLifecycleEvent(req.params.pageId, req.user._id, "file_created", texName);

      getIO()?.to(`page:${req.params.pageId}`).emit("file:created", { file });
      res.status(201).json({ file });
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

// 9. Save a PDF thumbnail — uploads JPEG to R2, stores the proxy URL in MongoDB
pageRouter.put(
  "/pages/:pageId/thumbnail",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const { dataUrl } = req.body;
      if (!dataUrl) return res.status(400).json({ error: "dataUrl is required" });

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

      const thumbnailUrl = `${req.protocol}://${req.get("host")}/api/files/${key}`;
      req.page.pdfThumbnail = thumbnailUrl;
      await req.page.save();

      res.json({ pdfThumbnail: thumbnailUrl });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// ── Binary asset endpoints (File model, R2-backed) ────────────────────────────
// These are used by FilesTab for images, PDFs, etc.
// The compiler-sync step happens inside /api/files/upload (files.js),
// so these endpoints only need to handle the page-scoped metadata view.

// 10. List assets for a page-project (File model, R2-backed)
pageRouter.get(
  "/pages/:pageId/assets",
  isAuthenticated,
  checkPageAccess(["manager", "member", "viewer"]),
  async (req, res) => {
    try {
      const { parentId } = req.query;
      // Assets are stored in FileModel keyed by project, not pageId.
      // We use the project ID from the page to find all related files.
      const project = req.project;
      const query = {
        project: project._id,
        parent: parentId || null,
        trashedAt: null,
        isFolder: false,
      };
      const assets = await FileModel.find(query)
        .populate("author", "name email avatar")
        .sort({ filename: 1 });
      res.json({ assets });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// 10b. Get a presigned upload URL for a page asset
pageRouter.post(
  "/pages/:pageId/assets/presign",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const { fileName } = req.body;
      if (!fileName)
        return res.status(400).json({ error: "fileName is required" });
      const key = `page-assets/${req.params.pageId}/${Date.now()}-${fileName}`;
      const presignedUrl = await getSignedUrl(
        r2,
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: key,
        }),
        { expiresIn: 3600 },
      );
      res.json({ url: presignedUrl, path: key });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// ── Sync endpoints ────────────────────────────────────────────────────────────

/**
 * POST /pages/:pageId/sync-project
 *
 * Bulk-sync ALL .tex files for a root page-project from MongoDB to the compiler.
 * Call this once when opening the editor to ensure the compiler has fresh content
 * after a restart / cold deployment.
 *
 * Only syncs text (.tex) files — binary assets are synced individually on upload.
 * Responds immediately (non-blocking) after dispatching the bulk sync.
 */
pageRouter.post(
  "/pages/:pageId/sync-project",
  isAuthenticated,
  checkPageAccess(["manager", "member", "viewer"]),
  async (req, res) => {
    try {
      const rootPage = req.page;
      if (rootPage.parentPage) {
        return res.status(400).json({ error: "Only root pages can sync a project" });
      }

      const folderId = rootPage._id.toString();

      // Fetch root + all children in parallel.
      const childFiles = await PageModel.find({ parentPage: rootPage._id })
        .select("_id title content")
        .lean();

      // Build { relativePath → base64 } map from child pages.
      // Root page has no LaTeX content — the main file is always a child page.
      const files = {};

      // Child text files (.tex, .bib, .cls, .sty, etc.)
      for (const child of childFiles) {
        const texName = pageTexName(child);
        files[texName] = textToBase64(child.content ?? "");
      }

      // Binary assets (images, .bib, etc.) from FileModel
      // Filter by pageId (root page ID) so we only sync assets belonging to
      // THIS specific LaTeX page-project, not all files in the MongoDB project.
      const binaryFiles = await FileModel.find({
        pageId: rootPage._id,
        trashedAt: null,
        isFolder: false,
        url: { $exists: true, $ne: null },
      }).lean();

      for (const bf of binaryFiles) {
        try {
          const key = bf.url?.split("/api/files/")[1];
          if (!key) continue;
          const r2Resp = await r2.send(new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
          }));
          const chunks = [];
          for await (const chunk of r2Resp.Body) chunks.push(chunk);
          const b64 = Buffer.concat(chunks).toString("base64");
          const relPath = await buildRelativePath(bf.filename, bf.parent);
          files[relPath] = b64;
        } catch (err) {
          console.warn(`[sync-project] failed to sync asset ${bf.filename}:`, err.message);
        }
      }

      if (Object.keys(files).length === 0) {
        return res.json({ ok: true, synced: 0 });
      }

      // Bulk sync — awaited so caller knows if it succeeded.
      await bulkSyncToCompiler(folderId, files);

      res.json({ ok: true, synced: Object.keys(files).length });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// ── Version control ───────────────────────────────────────────────────────────

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
      const texName = pageTexName(page);

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
      ).select("_id title content parentPage");

      // Re-sync the restored content to compiler.
      if (page) {
        const folderId = projectFolderKey(page);
        await syncFileToCompilerReliable(folderId, pageTexName(page), textToBase64(page.content ?? ""));
      }

      res.json({ page });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

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

// ── Project history ───────────────────────────────────────────────────────────

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

      const [rootPage, childFiles] = await Promise.all([
        PageModel.findById(folderId).select("_id title content parentPage"),
        PageModel.find({ parentPage: folderId }).select(
          "_id title content parentPage",
        ),
      ]);
      if (!rootPage)
        return res.status(404).json({ error: "Project not found" });

      const restoredFiles = {};
      const restored = [];

      for (const p of [rootPage, ...childFiles]) {
        const snapshot = await PageVersionModel.findOne({
          page: p._id,
          eventType: { $in: ["manual_save", "auto_save"] },
          createdAt: { $lte: T },
        }).sort({ createdAt: -1 });

        if (snapshot) {
          await PageModel.findByIdAndUpdate(p._id, {
            content: snapshot.content,
          });
          const texName = pageTexName(p);
          restoredFiles[texName] = textToBase64(snapshot.content ?? "");
          restored.push({
            pageId: p._id.toString(),
            title: p.title,
            content: snapshot.content ?? "",
          });
        }
      }

      // Bulk-sync all restored files in one request.
      bulkSyncToCompiler(folderId, restoredFiles);

      res.json({ restored, restoredAt: T });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

export default pageRouter;
