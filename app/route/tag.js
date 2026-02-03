import { Router } from "express";
import TagModel from "../schema/tag.js";
import { isAuthenticated, checkWorkspaceRole } from "../middleware/checkWorkspaceRole.js";

const tagRouter = Router();

// Get Tags
tagRouter.get(
  "/workspace/:workspaceId/tags",
  isAuthenticated,
  (req, res, next) => {
      req.params.id = req.params.workspaceId;
      next();
  },
  checkWorkspaceRole("owner", "admin", "member"), // Access to view tags
  async (req, res) => {
    try {
      const tags = await TagModel.find({ workspace: req.workspace._id })
        .populate('createdBy', 'name avatar')
        .sort({ name: 1 });

      res.json({ tags });
    } catch (error) {
        console.error("Tags GET Error:", error);
        res.status(500).json({ error: error.message });
    }
  }
);

// Create Tag
tagRouter.post(
  "/workspace/:workspaceId/tags",
  isAuthenticated,
  (req, res, next) => {
      req.params.id = req.params.workspaceId;
      next();
  },
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    try {
      const { name, color } = req.body;

      // Check if tag with same name already exists in workspace
      const existingTag = await TagModel.findOne({ 
        workspace: req.workspace._id, 
        name: name.trim() 
      });
      
      if (existingTag) {
        return res.status(400).json({ error: "Tag with this name already exists" });
      }

      const newTag = new TagModel({
        name: name.trim(),
        color: color || "#3b82f6",
        workspace: req.workspace._id,
        createdBy: req.user._id
      });

      await newTag.save();
      await newTag.populate('createdBy', 'name avatar');

      res.status(201).json({ tag: newTag });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Update Tag
tagRouter.put(
  "/tags/:tagId",
  isAuthenticated,
  async (req, res) => {
    try {
      const { tagId } = req.params;
      const { name, color } = req.body;
      
      const tag = await TagModel.findById(tagId);
      if (!tag) {
        return res.status(404).json({ error: "Tag not found" });
      }

      // Prepare fallback: if tag uses 'project' (old data), mapping might fail if we strictly check workspace middleware.
      // But assuming stickies are migrated or we accept breakage for old data as per warning.
      // We need to inject workspaceId.
      req.params.id = tag.workspace?.toString();

      // Check workspace access
      await checkWorkspaceRole("owner", "admin")(req, res, async () => {
        // Check if tag with same name already exists (excluding current tag)
        if (name && name.trim() !== tag.name) {
          const existingTag = await TagModel.findOne({ 
            workspace: tag.workspace, 
            name: name.trim() 
          });
          
          if (existingTag) {
            return res.status(400).json({ error: "Tag with this name already exists" });
          }
        }

        const updateData = {};
        if (name) updateData.name = name.trim();
        if (color) updateData.color = color;

        const updatedTag = await TagModel.findByIdAndUpdate(
          tagId, 
          updateData, 
          { new: true }
        ).populate('createdBy', 'name avatar');

        res.json({ tag: updatedTag });
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// Delete Tag
tagRouter.delete(
  "/tags/:tagId",
  isAuthenticated,
  async (req, res) => {
    try {
      const { tagId } = req.params;
      
      const tag = await TagModel.findById(tagId);
      if (!tag) {
        return res.status(404).json({ error: "Tag not found" });
      }

      req.params.id = tag.workspace?.toString();

      // Check workspace access
      await checkWorkspaceRole("owner", "admin")(req, res, async () => {
        await TagModel.findByIdAndDelete(tagId);
        res.status(204).end();
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

export default tagRouter;