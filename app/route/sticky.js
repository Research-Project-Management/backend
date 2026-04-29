import { Router } from "express";
import mongoose from "mongoose";
import { StickyModel, StickyNoteLinkModel, TagModel } from "../schema/sticky.js";
import {
  isAuthenticated,
  checkWorkspaceRole,
  checkProjectRole,
} from "../middleware/checkWorkspaceRole.js";
import { mapWorkspaceId, asyncHandler } from "../middleware/helpers.js";

const stickyRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

const populateNote = (target) => 
  target.populate([
    { path: "tags", select: "name color" },
    { path: "author", select: "name avatar" }
  ]);


// ── Tag Routes ────────────────────────────────────────────────────────────────

/**
 * @route   GET /api/workspace/:workspaceId/tags
 * @desc    Get all tags in a workspace created by the user
 */
stickyRouter.get(
  "/workspace/:workspaceId/tags",
  isAuthenticated,
  mapWorkspaceId,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const tags = await TagModel.find({ 
      workspace: req.workspace._id,
      createdBy: req.user._id 
    })
      .populate("createdBy", "name avatar")
      .sort({ name: 1 });

    res.json({ tags });
  }),
);

/**
 * @route   POST /api/workspace/:workspaceId/tags
 * @desc    Create a new tag in a workspace
 */
stickyRouter.post(
  "/workspace/:workspaceId/tags",
  isAuthenticated,
  mapWorkspaceId,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ error: "Tag name is required" });

    const newTag = new TagModel({
      name: name.trim(),
      color: color || "#3b82f6",
      workspace: req.workspace._id,
      createdBy: req.user._id,
    });

    await newTag.save();
    await newTag.populate("createdBy", "name avatar");
    res.status(201).json({ tag: newTag });
  }),
);

/**
 * @route   PUT /api/tags/:tagId
 */
stickyRouter.put(
  "/tags/:tagId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { tagId } = req.params;
    const { name, color } = req.body;

    const tag = await TagModel.findById(tagId);
    if (!tag) return res.status(404).json({ error: "Tag not found" });

    if (tag.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Access denied. Only the creator can edit this tag." });
    }

    if (name) tag.name = name.trim();
    if (color) tag.color = color;

    await tag.save();
    res.json({ tag });
  }),
);

/**
 * @route   DELETE /api/tags/:tagId
 */
stickyRouter.delete(
  "/tags/:tagId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { tagId } = req.params;
    const tag = await TagModel.findById(tagId);
    if (!tag) return res.status(404).json({ error: "Tag not found" });

    if (tag.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Access denied. Only the creator can delete this tag." });
    }

    await TagModel.findByIdAndDelete(tagId);
    
    // Cleanup: Remove tag reference from all stickies
    await StickyModel.updateMany(
      { tags: tagId },
      { $pull: { tags: tagId } }
    );

    res.status(204).end();
  }),
);


// ── Project Note Specific Routes (Legacy support) ───────────────────────────

/**
 * @route   GET /api/project/:projectId/notes
 */
stickyRouter.get(
  "/project/:projectId/notes",
  isAuthenticated,
  checkProjectRole("manager", "member", "viewer"),
  asyncHandler(async (req, res) => {
    const { tags } = req.query;
    const projectId = req.project._id;

    // Strictly personal: Only fetch notes created by the current user
    const query = { projectId: projectId, author: req.user._id };
    if (tags) {
      const tagIds = tags.split(",");
      if (tagIds.length > 0) query.tags = { $in: tagIds };
    }

    const notes = await populateNote(StickyModel.find(query)).sort({ order: 1, createdAt: -1 });
    res.json({ notes });
  }),
);

/**
 * @route   PUT /api/project/:projectId/notes/reorder
 */
stickyRouter.put(
  "/project/:projectId/notes/reorder",
  isAuthenticated,
  checkProjectRole("manager", "member"),
  asyncHandler(async (req, res) => {
    const { noteIds } = req.body;
    if (!Array.isArray(noteIds)) return res.status(400).json({ error: "noteIds must be an array" });

    // Ensure users can only reorder their own notes
    const ops = noteIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id, author: req.user._id, projectId: req.project._id },
        update: { $set: { order: index } }
      }
    }));

    if (ops.length > 0) await StickyModel.bulkWrite(ops);
    res.json({ message: "Reordered successfully" });
  }),
);


// ── Unified Sticky & Note Routes ──────────────────────────────────────────────

/**
 * @route   GET /api/workspace/:workspaceId/stickies
 * @desc    Get personal stickies in a workspace (Isolated from project notes by default)
 */
stickyRouter.get(
  "/workspace/:workspaceId/stickies",
  isAuthenticated,
  mapWorkspaceId,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const { tags, category, projectId } = req.query;
    const hasProjectFilter = projectId && projectId !== "null" && projectId !== "undefined" && projectId !== "";
    
    // Strictly personal: author check
    const query = { 
      workspace: req.workspace._id,
      author: req.user._id
    };

    if (tags) {
      const tagIds = tags.split(",");
      if (tagIds.length > 0) query.tags = { $all: tagIds };
    }
    
    if (category) query.category = category;

    if (hasProjectFilter) {
      try {
        query.projectId = new mongoose.Types.ObjectId(projectId);
      } catch (e) {
        query.projectId = new mongoose.Types.ObjectId();
      }
    } else if (projectId === "null") {
      query.projectId = null;
    }
    // If projectId is not provided at all, we don't filter by it, 
    // showing both global stickies and project notes for the user.

    const stickies = await populateNote(StickyModel.find(query)).sort({ createdAt: -1 });
    res.json({ stickies });
  }),
);

/**
 * @route   PUT /api/workspace/:workspaceId/stickies/reorder
 */
stickyRouter.put(
  "/workspace/:workspaceId/stickies/reorder",
  isAuthenticated,
  mapWorkspaceId,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const { stickyIds } = req.body;
    if (!Array.isArray(stickyIds)) return res.status(400).json({ error: "stickyIds must be an array" });

    const ops = stickyIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id, author: req.user._id, workspace: req.workspace._id },
        update: { $set: { order: index } }
      }
    }));

    if (ops.length > 0) await StickyModel.bulkWrite(ops);
    res.json({ message: "Reordered successfully" });
  }),
);

/**
 * @route   POST /api/workspace/:workspaceId/stickies
 * @desc    Create a global sticky or project note (Personal)
 */
stickyRouter.post(
  "/workspace/:workspaceId/stickies",
  isAuthenticated,
  mapWorkspaceId,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const { title, content, color, tags, position, projectId, parentStickyId, category = "sticky" } = req.body;
    const effectiveCategory = projectId ? "note" : category;

    const createRecord = async () => {
      const newSticky = new StickyModel({
        title: title || "",
        content: content || "<p></p>",
        color: color || "yellow-1",
        tags: tags || [],
        position: position || { x: 0, y: 0 },
        workspace: req.workspace._id,
        author: req.user._id,
        category: effectiveCategory,
        projectId: effectiveCategory === "note" ? projectId : null,
      });

      await newSticky.save();
      await populateNote(newSticky);

      if (effectiveCategory === "note" && parentStickyId) {
        await StickyNoteLinkModel.findOneAndUpdate(
          { childNote: newSticky._id, author: req.user._id },
          {
            workspace: req.workspace._id,
            parentSticky: parentStickyId,
            childNote: newSticky._id,
            project: projectId,
            author: req.user._id,
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
      }
      res.status(201).json({ sticky: newSticky });
    };

    if (effectiveCategory === "note" && projectId) {
      req.params.projectId = projectId;
      return checkProjectRole("manager", "member", "viewer")(req, res, createRecord);
    }
    return createRecord();
  }),
);

/**
 * @route   PUT /api/stickies/:stickyId
 * @desc    Update sticky or note (Strictly Private)
 */
stickyRouter.put(
  "/stickies/:stickyId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { stickyId } = req.params;
    const sticky = await StickyModel.findById(stickyId);
    if (!sticky) return res.status(404).json({ error: "Sticky not found" });

    // ENFORCE PRIVACY: Only the author can update their notes
    if (sticky.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Access denied. You can only edit your own notes." });
    }

    const { title, content, color, tags, position, projectId } = req.body;
    const updateData = Object.fromEntries(
      Object.entries({ title, content, color, tags, position, projectId })
        .filter(([_, v]) => v !== undefined)
    );

    if (sticky.projectId || projectId) {
      updateData.category = "note";
    } else {
      delete updateData.projectId;
    }

    const updatedSticky = await populateNote(
      StickyModel.findByIdAndUpdate(stickyId, updateData, { new: true })
    );
    res.json({ sticky: updatedSticky });
  }),
);

/**
 * @route   DELETE /api/stickies/:stickyId
 * @desc    Delete sticky or note (Strictly Private)
 */
stickyRouter.delete(
  "/stickies/:stickyId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { stickyId } = req.params;
    const sticky = await StickyModel.findById(stickyId);
    if (!sticky) return res.status(404).json({ error: "Sticky not found" });

    // ENFORCE PRIVACY: Only the author can delete their notes
    if (sticky.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Access denied. You can only delete your own notes." });
    }

    await StickyModel.findByIdAndDelete(stickyId);
    
    // Clean up links created by this user
    await StickyNoteLinkModel.deleteMany({ 
      $or: [{ childNote: sticky._id }, { parentSticky: sticky._id }],
      author: req.user._id 
    });

    res.status(204).end();
  }),
);

// Compatibility Aliases
stickyRouter.put("/notes/:noteId", (req, res, next) => {
  req.params.stickyId = req.params.noteId;
  next();
}, stickyRouter.stack.find(s => s.route?.path === "/stickies/:stickyId" && s.route?.methods.put).handle);

stickyRouter.delete("/notes/:noteId", (req, res, next) => {
  req.params.stickyId = req.params.noteId;
  next();
}, stickyRouter.stack.find(s => s.route?.path === "/stickies/:stickyId" && s.route?.methods.delete).handle);


/**
 * @route   GET /api/stickies/:stickyId/children
 * @desc    Get project note children linked to a parent sticky (Personal view)
 */
stickyRouter.get(
  "/stickies/:stickyId/children",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { stickyId } = req.params;
    const parentSticky = await StickyModel.findById(stickyId);
    if (!parentSticky) return res.status(404).json({ error: "Parent sticky not found" });
    
    if (parentSticky.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Access denied." });
    }

    const links = await StickyNoteLinkModel.find({ 
      parentSticky: stickyId,
      author: req.user._id 
    })
      .populate({
        path: "childNote",
        populate: [{ path: "tags", select: "name color" }, { path: "author", select: "name avatar" }],
      })
      .populate({ path: "project", select: "name avatar" });

    res.json({ children: links });
  }),
);

/**
 * @route   POST /api/stickies/:stickyId/children
 */
stickyRouter.post(
  "/stickies/:stickyId/children",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { stickyId } = req.params;
    const { childNoteId } = req.body;

    const [parentSticky, childNote] = await Promise.all([
      StickyModel.findById(stickyId),
      StickyModel.findById(childNoteId),
    ]);

    if (!parentSticky) return res.status(404).json({ error: "Parent sticky not found" });
    if (!childNote || !childNote.projectId) return res.status(404).json({ error: "Child note not found" });
    
    if (
      parentSticky.author.toString() !== req.user._id.toString() ||
      childNote.author.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({ error: "You can only link your own notes." });
    }

    const link = await StickyNoteLinkModel.findOneAndUpdate(
      { childNote: childNote._id, author: req.user._id },
      {
        workspace: parentSticky.workspace,
        parentSticky: parentSticky._id,
        childNote: childNote._id,
        project: childNote.projectId,
        author: req.user._id,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
    .populate({
      path: "childNote",
      populate: [{ path: "tags", select: "name color" }, { path: "author", select: "name avatar" }],
    })
    .populate({ path: "project", select: "name avatar" });

    res.status(201).json({ link });
  }),
);

/**
 * @route   DELETE /api/stickies/:stickyId/children/:noteId
 */
stickyRouter.delete(
  "/stickies/:stickyId/children/:noteId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { stickyId, noteId } = req.params;
    const link = await StickyNoteLinkModel.findOne({
      parentSticky: stickyId,
      childNote: noteId,
      author: req.user._id
    });

    if (!link) return res.status(404).json({ error: "Link not found or no access." });

    await StickyNoteLinkModel.findByIdAndDelete(link._id);
    res.status(204).end();
  }),
);

export default stickyRouter;
