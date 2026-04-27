import { Router } from "express";
import StickyModel from "../schema/sticky.js";
import {
  isAuthenticated,
  checkWorkspaceRole,
} from "../middleware/checkWorkspaceRole.js";
import { mapWorkspaceId, asyncHandler } from "../middleware/helpers.js";
import { getIO } from "../libs/socket.js";

const stickyRouter = Router();

/**
 * @route   GET /api/workspace/:workspaceId/stickies
 * @desc    Get all stickies in a workspace (including project notes if not filtered)
 */
stickyRouter.get(
  "/workspace/:workspaceId/stickies",
  isAuthenticated,
  mapWorkspaceId,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const { tags, category, projectId } = req.query;
    
    // Base query: MUST be in the correct workspace
    const query = { 
      workspace: req.workspace._id,
      $or: [
        { category: 'sticky' }, // Shared stickies
        { author: req.user._id, category: 'note' } // ONLY my personal notes
      ]
    };
    
    if (tags) {
      const tagIds = tags.split(",");
      if (tagIds.length > 0) query.tags = { $in: tagIds };
    }
    
    // If specific category is requested, we need to be careful
    if (category) {
      if (category === 'sticky') {
        delete query.$or;
        query.category = 'sticky';
      } else if (category === 'note') {
        delete query.$or;
        query.category = 'note';
        query.author = req.user._id; // Force author filter for notes
      }
    }
    
    if (projectId) {
      query.projectId = projectId;
    }

    const stickies = await StickyModel.find(query)
      .populate({ path: "tags", select: "name color" })
      .populate("author", "name avatar")
      .sort({ createdAt: -1 });
    res.json({ stickies });
  }),
);

/**
 * @route   POST /api/workspace/:workspaceId/stickies
 * @desc    Create a global sticky in a workspace
 */
stickyRouter.post(
  "/workspace/:workspaceId/stickies",
  isAuthenticated,
  mapWorkspaceId,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const { title, content, color, tags, position, category = 'sticky' } = req.body;

    const newSticky = new StickyModel({
      title: title || "",
      content,
      color: color || "yellow-1",
      tags: tags || [],
      position: position || { x: 0, y: 0 },
      workspace: req.workspace._id,
      author: req.user._id,
      category: category,
    });

    await newSticky.save();
    await newSticky.populate({ path: "tags", select: "name color" });
    await newSticky.populate("author", "name avatar");

    // Emit events to the workspace room
    getIO()?.to(`workspace:${req.workspace._id}`).emit("sticky:created", { sticky: newSticky });
    if (category === 'note' && projectId) {
      getIO()?.to(`workspace:${req.workspace._id}`).emit("note:created", { note: newSticky });
    }

    res.status(201).json({ sticky: newSticky });
  }),
);

/**
 * @route   PUT /api/stickies/:stickyId
 */
stickyRouter.put(
  "/stickies/:stickyId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { stickyId } = req.params;
    const sticky = await StickyModel.findById(stickyId);
    if (!sticky) return res.status(404).json({ error: "Sticky not found" });

    // Cần quyền workspace để sửa
    req.params.workspaceId = sticky.workspace.toString();
    await checkWorkspaceRole("owner", "admin", "member")(req, res, async () => {
      const updatedSticky = await StickyModel.findByIdAndUpdate(
        stickyId,
        { ...req.body, category: sticky.category },
        { new: true },
      )
        .populate({ path: "tags", select: "name color" })
        .populate("author", "name avatar");

      // Broadcast to workspace room
      getIO()?.to(`workspace:${sticky.workspace}`).emit("sticky:updated", { sticky: updatedSticky });
      if (sticky.category === 'note' && sticky.projectId) {
        getIO()?.to(`workspace:${sticky.workspace}`).emit("note:updated", { note: updatedSticky });
      }

      res.json({ sticky: updatedSticky });
    });
  }),
);

/**
 * @route   DELETE /api/stickies/:stickyId
 */
stickyRouter.delete(
  "/stickies/:stickyId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { stickyId } = req.params;
    const sticky = await StickyModel.findById(stickyId);
    if (!sticky) return res.status(404).json({ error: "Sticky not found" });

    req.params.workspaceId = sticky.workspace.toString();
    await checkWorkspaceRole("owner", "admin", "member")(req, res, async () => {
      await StickyModel.findByIdAndDelete(stickyId);
      
      // Broadcast to workspace room
      getIO()?.to(`workspace:${sticky.workspace}`).emit("sticky:deleted", { stickyId });
      if (sticky.category === 'note' && sticky.projectId) {
        getIO()?.to(`workspace:${sticky.workspace}`).emit("note:deleted", { noteId: stickyId });
      }

      res.status(204).end();
    });
  }),
);

export default stickyRouter;
