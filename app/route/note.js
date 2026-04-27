import { Router } from "express";
import StickyModel from "../schema/sticky.js";
import {
  isAuthenticated,
  checkWorkspaceRole,
  checkProjectRole,
} from "../middleware/checkWorkspaceRole.js";
import { asyncHandler } from "../middleware/helpers.js";
import { getIO } from "../libs/socket.js";

const noteRouter = Router();

/**
 * @route   GET /api/project/:projectId/notes
 */
noteRouter.get(
  "/project/:projectId/notes",
  isAuthenticated,
  checkProjectRole("manager", "member", "viewer"),
  asyncHandler(async (req, res) => {
    const { tags } = req.query;
    const query = { 
      projectId: req.params.projectId,
      author: req.user._id,
      category: 'note'
    };
    
    if (tags) {
      const tagIds = tags.split(",");
      if (tagIds.length > 0) query.tags = { $in: tagIds };
    }

    const notes = await StickyModel.find(query)
      .populate({ path: "tags", select: "name color" })
      .populate("author", "name avatar")
      .sort({ createdAt: -1 });
    res.json({ notes });
  }),
);

/**
 * @route   POST /api/project/:projectId/notes
 */
noteRouter.post(
  "/project/:projectId/notes",
  isAuthenticated,
  checkProjectRole("manager", "member"),
  asyncHandler(async (req, res) => {
    const { title, content, color, tags } = req.body;

    const newNote = new StickyModel({
      title: title || "",
      content,
      color: color || "cyan-1",
      tags: tags || [],
      projectId: req.params.projectId,
      workspace: req.project.workspace,
      author: req.user._id,
      category: 'note',
    });

    await newNote.save();
    await newNote.populate({ path: "tags", select: "name color" });
    await newNote.populate("author", "name avatar");

    // Emit to workspace room so the global board and project view can sync
    getIO()?.to(`workspace:${req.project.workspace}`).emit("note:created", { note: newNote });
    getIO()?.to(`workspace:${req.project.workspace}`).emit("sticky:created", { sticky: newNote });

    res.status(201).json({ note: newNote });
  }),
);

/**
 * @route   PUT /api/notes/:noteId
 */
noteRouter.put(
  "/notes/:noteId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { noteId } = req.params;
    const note = await StickyModel.findById(noteId);
    if (!note) return res.status(404).json({ error: "Note not found" });

    // 1. Phải là tác giả mới được sửa
    if (note.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Only the author can edit this note." });
    }

    // 2. Kiểm tra quyền trong workspace (đảm bảo vẫn là member)
    req.params.workspaceId = note.workspace.toString();
    await checkWorkspaceRole("owner", "admin", "member")(req, res, async () => {
      const updatedNote = await StickyModel.findByIdAndUpdate(
        noteId,
        { ...req.body, category: 'note' },
        { new: true },
      )
        .populate({ path: "tags", select: "name color" })
        .populate("author", "name avatar");

      // Emit to workspace room
      getIO()?.to(`workspace:${note.workspace}`).emit("note:updated", { note: updatedNote });
      getIO()?.to(`workspace:${note.workspace}`).emit("sticky:updated", { sticky: updatedNote });

      res.json({ note: updatedNote });
    });
  }),
);

/**
 * @route   DELETE /api/notes/:noteId
 */
noteRouter.delete(
  "/notes/:noteId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { noteId } = req.params;
    const note = await StickyModel.findById(noteId);
    if (!note) return res.status(404).json({ error: "Note not found" });

    // 1. Phải là tác giả
    if (note.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Access denied." });
    }

    // 2. Kiểm tra quyền trong workspace
    req.params.workspaceId = note.workspace.toString();
    await checkWorkspaceRole("owner", "admin", "member")(req, res, async () => {
      await StickyModel.findByIdAndDelete(noteId);
      
      // Emit to workspace room
      getIO()?.to(`workspace:${note.workspace}`).emit("note:deleted", { noteId });
      getIO()?.to(`workspace:${note.workspace}`).emit("sticky:deleted", { stickyId: noteId });

      res.status(204).end();
    });
  }),
);

export default noteRouter;
