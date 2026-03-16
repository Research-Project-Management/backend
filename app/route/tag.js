import { Router } from "express";
import TagModel from "../schema/tag.js";
import { isAuthenticated, checkWorkspaceRole } from "../middleware/checkWorkspaceRole.js";
import { mapWorkspaceId, asyncHandler } from "../middleware/helpers.js";

const tagRouter = Router();

// Get Tags
tagRouter.get(
  "/workspace/:workspaceId/tags",
  isAuthenticated,
  mapWorkspaceId,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const tags = await TagModel.find({ workspace: req.workspace._id })
      .populate("createdBy", "name avatar")
      .sort({ name: 1 });
    res.json({ tags });
  }),
);

// Create Tag
tagRouter.post(
  "/workspace/:workspaceId/tags",
  isAuthenticated,
  mapWorkspaceId,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const { name, color } = req.body;

    const existingTag = await TagModel.findOne({
      workspace: req.workspace._id,
      name: name.trim(),
    });
    if (existingTag) {
      return res.status(400).json({ error: "Tag with this name already exists" });
    }

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

// Update Tag
tagRouter.put(
  "/tags/:tagId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { tagId } = req.params;
    const { name, color } = req.body;

    const tag = await TagModel.findById(tagId);
    if (!tag) return res.status(404).json({ error: "Tag not found" });

    req.params.id = tag.workspace?.toString();

    await checkWorkspaceRole("owner", "admin")(req, res, async () => {
      if (name && name.trim() !== tag.name) {
        const existingTag = await TagModel.findOne({
          workspace: tag.workspace,
          name: name.trim(),
        });
        if (existingTag) {
          return res.status(400).json({ error: "Tag with this name already exists" });
        }
      }

      const updateData = {};
      if (name) updateData.name = name.trim();
      if (color) updateData.color = color;

      const updatedTag = await TagModel.findByIdAndUpdate(tagId, updateData, { new: true })
        .populate("createdBy", "name avatar");
      res.json({ tag: updatedTag });
    });
  }),
);

// Delete Tag
tagRouter.delete(
  "/tags/:tagId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { tagId } = req.params;

    const tag = await TagModel.findById(tagId);
    if (!tag) return res.status(404).json({ error: "Tag not found" });

    req.params.id = tag.workspace?.toString();

    await checkWorkspaceRole("owner", "admin")(req, res, async () => {
      await TagModel.findByIdAndDelete(tagId);
      res.status(204).end();
    });
  }),
);

export default tagRouter;