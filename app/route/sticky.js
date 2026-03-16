import { Router } from "express";
import StickyModel from "../schema/sticky.js";
import {
  isAuthenticated,
  checkWorkspaceRole,
} from "../middleware/checkWorkspaceRole.js";
import { mapWorkspaceId, asyncHandler } from "../middleware/helpers.js";
import { getIO } from "../libs/socket.js";

const stickyRouter = Router();

// Get Stickies
stickyRouter.get(
  "/workspace/:workspaceId/stickies",
  isAuthenticated,
  mapWorkspaceId,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const { tags } = req.query;
    const query = { workspace: req.workspace._id };
    if (tags) {
      const tagIds = tags.split(",");
      if (tagIds.length > 0) query.tags = { $in: tagIds };
    }

    const stickies = await StickyModel.find(query)
      .populate({ path: "tags", select: "name color" })
      .populate("author", "name avatar")
      .sort({ createdAt: -1 });
    res.json({ stickies });
  }),
);

// Create Sticky
stickyRouter.post(
  "/workspace/:workspaceId/stickies",
  isAuthenticated,
  mapWorkspaceId,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const { title, content, color, tags, position } = req.body;

    const newSticky = new StickyModel({
      title: title || "",
      content,
      color: color || "yellow-1",
      tags: tags || [],
      position: position || { x: 0, y: 0 },
      workspace: req.workspace._id,
      author: req.user._id,
    });

    await newSticky.save();
    await newSticky.populate({ path: "tags", select: "name color" });
    await newSticky.populate("author", "name avatar");

    getIO()
      ?.to(`workspace:${req.workspace._id}`)
      .emit("sticky:created", { sticky: newSticky });
    res.status(201).json({ sticky: newSticky });
  }),
);

// Update Sticky
stickyRouter.put(
  "/stickies/:stickyId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { stickyId } = req.params;
    const updateData = req.body;

    const sticky = await StickyModel.findById(stickyId);
    if (!sticky) return res.status(404).json({ error: "Sticky not found" });

    req.params.id = sticky.workspace.toString();

    await checkWorkspaceRole("owner", "admin", "member")(req, res, async () => {
      const updatedSticky = await StickyModel.findByIdAndUpdate(
        stickyId,
        updateData,
        { new: true },
      )
        .populate({ path: "tags", select: "name color" })
        .populate("author", "name avatar");

      getIO()
        ?.to(`workspace:${sticky.workspace}`)
        .emit("sticky:updated", { sticky: updatedSticky });
      res.json({ sticky: updatedSticky });
    });
  }),
);

// Delete Sticky
stickyRouter.delete(
  "/stickies/:stickyId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { stickyId } = req.params;

    const sticky = await StickyModel.findById(stickyId);
    if (!sticky) return res.status(404).json({ error: "Sticky not found" });

    req.params.id = sticky.workspace.toString();

    await checkWorkspaceRole("owner", "admin", "member")(req, res, async () => {
      await StickyModel.findByIdAndDelete(stickyId);
      getIO()
        ?.to(`workspace:${sticky.workspace}`)
        .emit("sticky:deleted", { stickyId });
      res.status(204).end();
    });
  }),
);

export default stickyRouter;
