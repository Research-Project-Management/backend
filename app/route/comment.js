import { Router } from "express";
import PageModel from "../schema/page.js";
import PageCommentModel from "../schema/pageComment.js";
import ProjectModel from "../schema/project.js";
import WorkspaceModel from "../schema/workspace.js";
import { isAuthenticated } from "../middleware/checkWorkspaceRole.js";
import { getIO } from "../libs/socket.js";

const commentRouter = Router();

// ── Shared access check ────────────────────────────────────────────────────────
// Mirrors the checkPageAccess middleware from page.js but exported as a standalone.
const checkPageAccess = (requiredRoles) => async (req, res, next) => {
  try {
    const page = await PageModel.findById(req.params.pageId);
    if (!page) return res.status(404).json({ error: "Page not found" });

    const project = await ProjectModel.findById(page.project);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const workspace = await WorkspaceModel.findById(project.workspace).populate(
      "members.role",
    );
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

    const populated = await ProjectModel.findById(project._id).populate(
      "members.role",
    );
    const projectMember = populated.members.find(
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Populate helper ────────────────────────────────────────────────────────────
const AUTHOR_FIELDS = "name avatar";

function populateComment(query) {
  return query
    .populate("author", AUTHOR_FIELDS)
    .populate("replies.author", AUTHOR_FIELDS);
}

// ── GET /pages/:pageId/comments ────────────────────────────────────────────────
// Returns all comments for the page (or all files inside a project-root page).
commentRouter.get(
  "/pages/:pageId/comments",
  isAuthenticated,
  checkPageAccess(["manager", "member", "viewer"]),
  async (req, res) => {
    try {
      const page = req.page;
      // If this is a root page, return comments for all files in the project.
      const filter = page.parentPage
        ? { page: page._id }
        : { projectPageId: page._id };

      const comments = await populateComment(
        PageCommentModel.find(filter).sort({ createdAt: -1 }).limit(200),
      );
      res.json({ comments });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ── POST /pages/:pageId/comments ───────────────────────────────────────────────
commentRouter.post(
  "/pages/:pageId/comments",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const { content, line, lineEnd } = req.body;
      if (!content?.trim()) {
        return res.status(400).json({ error: "content is required" });
      }

      const page = req.page;
      const projectPageId = page.parentPage ?? page._id;

      const comment = await PageCommentModel.create({
        page: page._id,
        projectPageId,
        author: req.user._id,
        content: content.trim(),
        line: line ?? null,
        lineEnd: lineEnd ?? null,
      });

      await populateComment(PageCommentModel.findById(comment._id)).then(
        (c) => {
          getIO()?.to(`page:${page._id}`).emit("comment:created", { comment: c, projectPageId: projectPageId.toString() });
          res.status(201).json({ comment: c });
        },
      );
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ── PUT /pages/:pageId/comments/:commentId ─────────────────────────────────────
// Update content or status.
commentRouter.put(
  "/pages/:pageId/comments/:commentId",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const comment = await PageCommentModel.findOne({
        _id: req.params.commentId,
        page: req.params.pageId,
      });
      if (!comment) return res.status(404).json({ error: "Comment not found" });

      // Only the author can edit content; anyone with write access can change status.
      if (req.body.content !== undefined) {
        if (comment.author.toString() !== req.user._id.toString()) {
          return res.status(403).json({ error: "Not the comment author" });
        }
        comment.content = req.body.content.trim();
      }
      if (req.body.status !== undefined) {
        comment.status = req.body.status;
      }

      await comment.save();
      const updated = await populateComment(
        PageCommentModel.findById(comment._id),
      );
      getIO()?.to(`page:${req.params.pageId}`).emit("comment:updated", { comment: updated });
      res.json({ comment: updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ── DELETE /pages/:pageId/comments/:commentId ─────────────────────────────────
commentRouter.delete(
  "/pages/:pageId/comments/:commentId",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const comment = await PageCommentModel.findOne({
        _id: req.params.commentId,
        page: req.params.pageId,
      });
      if (!comment) return res.status(404).json({ error: "Comment not found" });

      // Authors can delete their own; managers can delete any.
      const isAuthor = comment.author.toString() === req.user._id.toString();
      const isManager =
        req.project?.members
          ?.find((m) => m.user.toString() === req.user._id.toString())
          ?.role?.name?.toLowerCase() === "manager";

      if (!isAuthor && !isManager) {
        return res.status(403).json({ error: "Not allowed" });
      }

      await comment.deleteOne();
      getIO()?.to(`page:${req.params.pageId}`).emit("comment:deleted", { commentId: req.params.commentId, pageId: req.params.pageId });
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ── POST /pages/:pageId/comments/:commentId/replies ───────────────────────────
commentRouter.post(
  "/pages/:pageId/comments/:commentId/replies",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const { content } = req.body;
      if (!content?.trim()) {
        return res.status(400).json({ error: "content is required" });
      }

      const comment = await PageCommentModel.findOne({
        _id: req.params.commentId,
        page: req.params.pageId,
      });
      if (!comment) return res.status(404).json({ error: "Comment not found" });

      comment.replies.push({ author: req.user._id, content: content.trim() });
      await comment.save();

      const updated = await populateComment(
        PageCommentModel.findById(comment._id),
      );
      getIO()?.to(`page:${req.params.pageId}`).emit("reply:added", { comment: updated });
      res.status(201).json({ comment: updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ── DELETE /pages/:pageId/comments/:commentId/replies/:replyId ───────────────
commentRouter.delete(
  "/pages/:pageId/comments/:commentId/replies/:replyId",
  isAuthenticated,
  checkPageAccess(["manager", "member"]),
  async (req, res) => {
    try {
      const comment = await PageCommentModel.findOne({
        _id: req.params.commentId,
        page: req.params.pageId,
      });
      if (!comment) return res.status(404).json({ error: "Comment not found" });

      const reply = comment.replies.id(req.params.replyId);
      if (!reply) return res.status(404).json({ error: "Reply not found" });

      const isAuthor = reply.author.toString() === req.user._id.toString();
      if (!isAuthor) {
        return res.status(403).json({ error: "Not the reply author" });
      }

      reply.deleteOne();
      await comment.save();

      const updated = await populateComment(
        PageCommentModel.findById(comment._id),
      );
      getIO()?.to(`page:${req.params.pageId}`).emit("reply:removed", { comment: updated });
      res.json({ comment: updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

export default commentRouter;
