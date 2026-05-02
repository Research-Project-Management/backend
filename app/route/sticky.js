import { Router } from "express";
import mongoose from "mongoose";
import { StickyModel, StickyChildLinkModel, LabelModel } from "../schema/sticky.js";
import {
  isAuthenticated,
  checkWorkspaceRole,
  checkProjectRole,
} from "../middleware/checkWorkspaceRole.js";
import { mapWorkspaceId, asyncHandler } from "../middleware/helpers.js";

const stickyRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

const populateSticky = (target) =>
  target.populate([
    { path: "labels", select: "name color" },
    { path: "author", select: "name avatar" }
  ]);

const parseLabelQuery = (labels) => {
  if (!labels) return [];
  const values = Array.isArray(labels) ? labels : [labels];

  return values
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
};


// ── Tag Routes ────────────────────────────────────────────────────────────────

/**
 * @route   GET /api/workspace/:workspaceId/labels
 * @desc    Get labels in a workspace (Filtered by type: sticky | cycle)
 * @access  Private (Owner, Admin, Member)
 */
stickyRouter.get(
  "/workspace/:workspaceId/labels",
  isAuthenticated,
  mapWorkspaceId,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const { type } = req.query;
    const filter = { workspace: req.workspace._id };

    if (type && ["sticky", "cycle", "task"].includes(type)) {
      filter.type = type;
    } else if (type) {
      return res.json({ labels: [] });
    }

    const labels = await LabelModel.find(filter)
      .populate("createdBy", "name avatar")
      .sort({ name: 1 });

    res.json({ labels });
  }),
);

/**
 * @route   POST /api/workspace/:workspaceId/labels
 */
stickyRouter.post(
  "/workspace/:workspaceId/labels",
  isAuthenticated,
  mapWorkspaceId,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const { name, color, type } = req.body;
    if (!name) return res.status(400).json({ error: "Label name is required" });

    const newLabel = new LabelModel({
      name: name.trim(),
      color: color || "#3b82f6",
      type: type || "sticky",
      workspace: req.workspace._id,
      createdBy: req.user._id,
    });

    await newLabel.save();
    await newLabel.populate("createdBy", "name avatar");
    res.status(201).json({ label: newLabel });
  }),
);

/**
 * @route   PUT /api/labels/:labelId
 */
stickyRouter.put(
  "/labels/:labelId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { labelId } = req.params;
    const { name, color } = req.body;

    const label = await LabelModel.findById(labelId).populate("workspace");
    if (!label) return res.status(404).json({ error: "Label not found" });

    const isCreator = label.createdBy.toString() === req.user._id.toString();
    const workspace = label.workspace;
    const userInWorkspace = workspace.members.find(m => m.user.toString() === req.user._id.toString());
    const isAdmin = userInWorkspace && ["owner", "admin"].includes(userInWorkspace.role?.name?.toLowerCase() || "");
    
    if (!isCreator && !isAdmin) {
      return res.status(403).json({ error: "Access denied." });
    }

    if (name) label.name = name.trim();
    if (color) label.color = color;
    await label.save();
    res.json({ label });
  }),
);

/**
 * @route   DELETE /api/labels/:labelId
 */
stickyRouter.delete(
  "/labels/:labelId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { labelId } = req.params;
    const label = await LabelModel.findById(labelId).populate("workspace");
    if (!label) return res.status(404).json({ error: "Label not found" });

    const isCreator = label.createdBy.toString() === req.user._id.toString();
    const workspace = label.workspace;
    const userInWorkspace = workspace.members.find(m => m.user.toString() === req.user._id.toString());
    const isAdmin = userInWorkspace && ["owner", "admin"].includes(userInWorkspace.role?.name?.toLowerCase() || "");

    if (!isCreator && !isAdmin) {
      return res.status(403).json({ error: "Access denied." });
    }

    await LabelModel.findByIdAndDelete(labelId);
    res.status(204).end();
  }),
);


// ── Project Sticky Routes ───────────────────────────────────────────────────

/**
 * @route   GET /api/project/:projectId/stickies
 */
stickyRouter.get(
  "/project/:projectId/stickies",
  isAuthenticated,
  checkProjectRole("manager", "member", "viewer"),
  asyncHandler(async (req, res) => {
    const { labels } = req.query;
    const query = { projectId: req.project._id, author: req.user._id };
    const labelIds = parseLabelQuery(labels);
    if (labelIds.length > 0) query.labels = { $in: labelIds };

    const stickies = await populateSticky(StickyModel.find(query)).sort({ order: 1, createdAt: -1 });
    res.json({ stickies });
  }),
);

/**
 * @route   PUT /api/project/:projectId/stickies/reorder
 */
stickyRouter.put(
  "/project/:projectId/stickies/reorder",
  isAuthenticated,
  checkProjectRole("manager", "member"),
  asyncHandler(async (req, res) => {
    const { stickyIds } = req.body;
    if (!Array.isArray(stickyIds)) return res.status(400).json({ error: "stickyIds must be an array" });

    const ops = stickyIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id, author: req.user._id, projectId: req.project._id },
        update: { $set: { order: index } }
      }
    }));

    if (ops.length > 0) await StickyModel.bulkWrite(ops);
    res.json({ message: "Reordered successfully" });
  }),
);


// ── Sticky Routes ────────────────────────────────────────────────────────────

/**
 * @route   GET /api/workspace/:workspaceId/stickies
 * @desc    Get personal stickies in a workspace
 */
stickyRouter.get(
  "/workspace/:workspaceId/stickies",
  isAuthenticated,
  mapWorkspaceId,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const { labels, category, scope, projectId } = req.query;
    const hasProjectFilter = projectId && projectId !== "null" && projectId !== "undefined" && projectId !== "";
    
    const query = { 
      workspace: req.workspace._id,
      author: req.user._id
    };

    const labelIds = parseLabelQuery(labels);
    if (labelIds.length > 0) query.labels = { $all: labelIds };
    
    if (scope === "project") query.projectId = { $ne: null };
    else if (scope === "workspace" || category === "sticky") query.projectId = null;
    else if (category === "note") query.projectId = { $ne: null };

    if (hasProjectFilter) {
      try {
        query.projectId = new mongoose.Types.ObjectId(projectId);
      } catch (e) {
        query.projectId = new mongoose.Types.ObjectId();
      }
    } else if (projectId === "null") {
      query.projectId = null;
    }

    const stickies = await populateSticky(StickyModel.find(query)).sort({ order: 1, createdAt: -1 });
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
 */
stickyRouter.post(
  "/workspace/:workspaceId/stickies",
  isAuthenticated,
  mapWorkspaceId,
  checkWorkspaceRole("owner", "admin", "member"),
  asyncHandler(async (req, res) => {
    const { title, content, color, labels, position, projectId, parentStickyId } = req.body;
    const isProjectSticky = Boolean(projectId);

    const createRecord = async () => {
      const newSticky = new StickyModel({
        title: title || "",
        content: content || "<p></p>",
        color: color || "yellow-1",
        labels: labels || [],
        position: position || { x: 0, y: 0 },
        workspace: req.workspace._id,
        author: req.user._id,
        scope: isProjectSticky ? "project" : "workspace",
        category: "sticky",
        projectId: isProjectSticky ? projectId : null,
      });

      await newSticky.save();
      await populateSticky(newSticky);

      if (isProjectSticky && parentStickyId) {
        await StickyChildLinkModel.findOneAndUpdate(
          { childSticky: newSticky._id, author: req.user._id },
          {
            workspace: req.workspace._id,
            parentSticky: parentStickyId,
            childSticky: newSticky._id,
            project: projectId,
            author: req.user._id,
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
      }
      res.status(201).json({ sticky: newSticky });
    };

    if (isProjectSticky && projectId) {
      req.params.projectId = projectId;
      return checkProjectRole("manager", "member", "viewer")(req, res, createRecord);
    }
    return createRecord();
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

    if (sticky.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Access denied." });
    }

    const { title, content, color, labels, position, projectId } = req.body;
    const updateData = Object.fromEntries(
      Object.entries({ title, content, color, labels, position, projectId })
        .filter(([_, v]) => v !== undefined)
    );

    if (sticky.projectId || projectId) {
      updateData.scope = "project";
    } else {
      updateData.scope = "workspace";
    }

    const updatedSticky = await populateSticky(
      StickyModel.findByIdAndUpdate(stickyId, updateData, { new: true })
    );
    res.json({ sticky: updatedSticky });
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

    if (sticky.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Access denied." });
    }

    await StickyModel.findByIdAndDelete(stickyId);
    await StickyChildLinkModel.deleteMany({ 
      $or: [{ childSticky: sticky._id }, { childNote: sticky._id }, { parentSticky: sticky._id }],
      author: req.user._id 
    });

    res.status(204).end();
  }),
);

/**
 * @route   GET /api/stickies/:stickyId/children
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

    const links = await StickyChildLinkModel.find({ 
      parentSticky: stickyId,
      author: req.user._id 
    })
      .select("+childNote")
      .populate({
        path: "childSticky",
        populate: [{ path: "labels", select: "name color" }, { path: "author", select: "name avatar" }],
      })
      .populate({
        path: "childNote",
        populate: [{ path: "labels", select: "name color" }, { path: "author", select: "name avatar" }],
      })
      .populate({ path: "project", select: "name avatar" });

    res.json({
      children: links.map((link) => ({
        ...link.toObject(),
        sticky: link.childSticky || link.childNote,
      })),
    });
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
    const { childStickyId, childNoteId } = req.body;
    const resolvedChildStickyId = childStickyId || childNoteId;

    const [parentSticky, childSticky] = await Promise.all([
      StickyModel.findById(stickyId),
      StickyModel.findById(resolvedChildStickyId),
    ]);

    if (!parentSticky) return res.status(404).json({ error: "Parent sticky not found" });
    if (!childSticky || !childSticky.projectId) return res.status(404).json({ error: "Child sticky not found" });
    
    if (
      parentSticky.author.toString() !== req.user._id.toString() ||
      childSticky.author.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({ error: "Access denied." });
    }

    const link = await StickyChildLinkModel.findOneAndUpdate(
      { childSticky: childSticky._id, author: req.user._id },
      {
        workspace: parentSticky.workspace,
        parentSticky: parentSticky._id,
        childSticky: childSticky._id,
        project: childSticky.projectId,
        author: req.user._id,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
    .populate({
      path: "childSticky",
      populate: [{ path: "tags", select: "name color" }, { path: "author", select: "name avatar" }],
    })
    .populate({ path: "project", select: "name avatar" });

    res.status(201).json({ link: { ...link.toObject(), sticky: link.childSticky || link.childNote } });
  }),
);

/**
 * @route   DELETE /api/stickies/:stickyId/children/:childStickyId
 */
stickyRouter.delete(
  "/stickies/:stickyId/children/:childStickyId",
  isAuthenticated,
  asyncHandler(async (req, res) => {
    const { stickyId, childStickyId } = req.params;
    const link = await StickyChildLinkModel.findOne({
      parentSticky: stickyId,
      $or: [{ childSticky: childStickyId }, { childNote: childStickyId }],
      author: req.user._id
    });

    if (!link) return res.status(404).json({ error: "Link not found or no access." });

    await StickyChildLinkModel.findByIdAndDelete(link._id);
    res.status(204).end();
  }),
);

export default stickyRouter;
