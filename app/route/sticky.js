import { Router } from "express";
import StickyModel from "../schema/sticky.js";
import {
  isAuthenticated,
  checkWorkspaceRole,
} from "../middleware/checkWorkspaceRole.js";
import { getIO } from "../libs/socket.js";

const stickyRouter = Router();

// Get Stickies
stickyRouter.get(
  "/workspace/:workspaceId/stickies",
  isAuthenticated,
  (req, res, next) => {
    req.params.id = req.params.workspaceId; // Map workspaceId to id for middleware
    next();
  },
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    try {
      const { tags } = req.query;

      const query = { workspace: req.workspace._id }; // Use resolved workspace ID
      if (tags) {
        const tagIds = tags.split(",");
        if (tagIds.length > 0) {
          query.tags = { $in: tagIds };
        }
      }

      const stickies = await StickyModel.find(query)
        .populate({
          path: "tags",
          select: "name color",
        })
        .populate("author", "name avatar")
        .sort({ createdAt: -1 });
      res.json({ stickies });
    } catch (error) {
      console.error("Sticky GET Error:", error);
      res.status(500).json({ error: error.message, stack: error.stack });
    }
  },
);

// Create Sticky
stickyRouter.post(
  "/workspace/:workspaceId/stickies",
  isAuthenticated,
  (req, res, next) => {
    req.params.id = req.params.workspaceId;
    next();
  },
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    try {
      const { title, content, color, tags, position } = req.body;

      const newSticky = new StickyModel({
        title: title || "",
        content,
        color: color || "yellow-1",
        tags: tags || [],
        position: position || { x: 0, y: 0 },
        workspace: req.workspace._id, // Use resolved workspace ID
        author: req.user._id,
      });

      await newSticky.save();
      await newSticky.populate({
        path: "tags",
        select: "name color",
      });
      await newSticky.populate("author", "name avatar");

      getIO()?.to(`workspace:${req.workspace._id}`).emit("sticky:created", { sticky: newSticky });
      res.status(201).json({ sticky: newSticky });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Update Sticky
stickyRouter.put("/stickies/:stickyId", isAuthenticated, async (req, res) => {
  try {
    const { stickyId } = req.params;
    const updateData = req.body;

    const sticky = await StickyModel.findById(stickyId);
    if (!sticky) {
      return res.status(404).json({ error: "Sticky not found" });
    }

    // Check workspace access via the sticky's workspace
    req.params.id = sticky.workspace.toString();

    await checkWorkspaceRole("owner", "admin", "member")(req, res, async () => {
      const updatedSticky = await StickyModel.findByIdAndUpdate(
        stickyId,
        updateData,
        { new: true },
      )
        .populate({
          path: "tags",
          select: "name color",
        })
        .populate("author", "name avatar");

      getIO()?.to(`workspace:${sticky.workspace}`).emit("sticky:updated", { sticky: updatedSticky });
      res.json({ sticky: updatedSticky });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Sticky
stickyRouter.delete(
  "/stickies/:stickyId",
  isAuthenticated,
  async (req, res) => {
    try {
      const { stickyId } = req.params;

      const sticky = await StickyModel.findById(stickyId);
      if (!sticky) {
        return res.status(404).json({ error: "Sticky not found" });
      }

      req.params.id = sticky.workspace.toString();

      await checkWorkspaceRole("owner", "admin", "member")(
        req,
        res,
        async () => {
          await StickyModel.findByIdAndDelete(stickyId);
          getIO()?.to(`workspace:${sticky.workspace}`).emit("sticky:deleted", { stickyId });
          res.status(204).end();
        },
      );
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  },
);

export default stickyRouter;
