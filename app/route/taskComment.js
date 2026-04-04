import { Router } from "express";
import TaskCommentModel from "../schema/taskComment.js";
import { isAuthenticated } from "../middleware/checkWorkspaceRole.js";
import { checkTaskRole } from "../middleware/checkTaskRole.js";
import { getIO } from "../libs/socket.js";

const taskCommentRouter = Router();

const AUTHOR_FIELDS = "name avatar";
const REACTION_OPTIONS = ["👍", "❤️", "😆", "😮", "😢", "😡"];

function populateTaskComment(query) {
	return query
		.populate("author", AUTHOR_FIELDS)
		.populate("replies.author", AUTHOR_FIELDS);
}

function toTaskCommentResponse(comment, req) {
	const raw = comment.toObject();
	const currentUserId = req.user._id.toString();
	const isManager = req.projectRole === "manager";
	const isAuthor = raw.author?._id?.toString?.() === currentUserId;
	const reactions = raw.reactions || [];
	const currentUserReaction = reactions.find(
		(reaction) => reaction?.user?.toString?.() === currentUserId,
	)?.emoji;

	return {
		...raw,
		reactions,
		currentUserReaction,
		permissions: {
			canEdit: isAuthor,
			canDelete: isManager || isAuthor,
			canReply: req.projectRole === "manager" || req.projectRole === "member",
		},
		replies: (raw.replies || []).map((reply) => {
			const isReplyAuthor = reply.author?._id?.toString?.() === currentUserId;
			return {
				...reply,
				permissions: {
					canDelete: isManager || isReplyAuthor,
				},
			};
		}),
	};
}

taskCommentRouter.get(
	"/tasks/:taskId/comments/count",
	isAuthenticated,
	checkTaskRole("manager", "member", "viewer"),
	async (req, res) => {
		try {
			const count = await TaskCommentModel.countDocuments({ task: req.params.taskId });
			res.json({ count });
		} catch (error) {
			res.status(500).json({ error: error.message });
		}
	},
);

taskCommentRouter.get(
	"/tasks/:taskId/comments",
	isAuthenticated,
	checkTaskRole("manager", "member", "viewer"),
	async (req, res) => {
		try {
			const comments = await populateTaskComment(
				TaskCommentModel.find({ task: req.params.taskId })
					.sort({ createdAt: -1 })
					.limit(200),
			);

			res.json({ comments: comments.map((comment) => toTaskCommentResponse(comment, req)) });
		} catch (error) {
			res.status(500).json({ error: error.message });
		}
	},
);

taskCommentRouter.post(
	"/tasks/:taskId/comments",
	isAuthenticated,
	checkTaskRole("manager", "member"),
	async (req, res) => {
		try {
			const { content } = req.body;
			if (!content?.trim()) {
				return res.status(400).json({ error: "content is required" });
			}

			const comment = await TaskCommentModel.create({
				task: req.task._id,
				project: req.project._id,
				author: req.user._id,
				content: content.trim(),
			});

			const populated = await populateTaskComment(
				TaskCommentModel.findById(comment._id),
			);

			getIO()?.to(`project:${req.project._id}`).emit("task-comment:created", {
				taskId: req.task._id,
				comment: toTaskCommentResponse(populated, req),
			});

			res.status(201).json({ comment: toTaskCommentResponse(populated, req) });
		} catch (error) {
			res.status(500).json({ error: error.message });
		}
	},
);

taskCommentRouter.put(
	"/tasks/:taskId/comments/:commentId",
	isAuthenticated,
	checkTaskRole("manager", "member"),
	async (req, res) => {
		try {
			const comment = await TaskCommentModel.findOne({
				_id: req.params.commentId,
				task: req.params.taskId,
			});
			if (!comment) return res.status(404).json({ error: "Comment not found" });
			if (comment.project.toString() !== req.project._id.toString()) {
				return res.status(403).json({ error: "Insufficient permissions" });
			}

			if (comment.author.toString() !== req.user._id.toString()) {
				return res.status(403).json({ error: "Not the comment author" });
			}

			if (!req.body.content?.trim()) {
				return res.status(400).json({ error: "content is required" });
			}

			comment.content = req.body.content.trim();
			await comment.save();

			const populated = await populateTaskComment(
				TaskCommentModel.findById(comment._id),
			);

			getIO()?.to(`project:${req.project._id}`).emit("task-comment:updated", {
				taskId: req.task._id,
				comment: toTaskCommentResponse(populated, req),
			});

			res.json({ comment: toTaskCommentResponse(populated, req) });
		} catch (error) {
			res.status(500).json({ error: error.message });
		}
	},
);

taskCommentRouter.delete(
	"/tasks/:taskId/comments/:commentId",
	isAuthenticated,
	checkTaskRole("manager", "member"),
	async (req, res) => {
		try {
			const comment = await TaskCommentModel.findOne({
				_id: req.params.commentId,
				task: req.params.taskId,
			});
			if (!comment) return res.status(404).json({ error: "Comment not found" });
			if (comment.project.toString() !== req.project._id.toString()) {
				return res.status(403).json({ error: "Insufficient permissions" });
			}

			const isAuthor = comment.author.toString() === req.user._id.toString();
			const isManager = req.projectRole === "manager";

			if (!isAuthor && !isManager) {
				return res.status(403).json({ error: "Not allowed" });
			}

			await comment.deleteOne();

			getIO()?.to(`project:${req.project._id}`).emit("task-comment:deleted", {
				taskId: req.task._id,
				commentId: req.params.commentId,
			});

			res.status(204).end();
		} catch (error) {
			res.status(500).json({ error: error.message });
		}
	},
);

taskCommentRouter.put(
	"/tasks/:taskId/comments/:commentId/reaction",
	isAuthenticated,
	checkTaskRole("manager", "member", "viewer"),
	async (req, res) => {
		try {
			const { emoji } = req.body;
			const normalizedEmoji = typeof emoji === "string" ? emoji.trim() : "";

			if (normalizedEmoji && !REACTION_OPTIONS.includes(normalizedEmoji)) {
				return res.status(400).json({ error: "Invalid emoji" });
			}

			const comment = await TaskCommentModel.findOne({
				_id: req.params.commentId,
				task: req.params.taskId,
			});

			if (!comment) return res.status(404).json({ error: "Comment not found" });
			if (comment.project.toString() !== req.project._id.toString()) {
				return res.status(403).json({ error: "Insufficient permissions" });
			}

			const userId = req.user._id.toString();
			const previousReactions = comment.reactions || [];
			const nextReactions = previousReactions.filter(
				(reaction) => reaction.user.toString() !== userId,
			);

			if (normalizedEmoji) {
				nextReactions.push({ user: req.user._id, emoji: normalizedEmoji });
			}

			comment.reactions = nextReactions;
			await comment.save();

			const populated = await populateTaskComment(TaskCommentModel.findById(comment._id));

			getIO()?.to(`project:${req.project._id}`).emit("task-comment:updated", {
				taskId: req.task._id,
				comment: toTaskCommentResponse(populated, req),
			});

			res.json({ comment: toTaskCommentResponse(populated, req) });
		} catch (error) {
			res.status(500).json({ error: error.message });
		}
	},
);

taskCommentRouter.post(
	"/tasks/:taskId/comments/:commentId/replies",
	isAuthenticated,
	checkTaskRole("manager", "member"),
	async (req, res) => {
		try {
			const { content } = req.body;
			if (!content?.trim()) {
				return res.status(400).json({ error: "content is required" });
			}

			const comment = await TaskCommentModel.findOne({
				_id: req.params.commentId,
				task: req.params.taskId,
			});
			if (!comment) return res.status(404).json({ error: "Comment not found" });
			if (comment.project.toString() !== req.project._id.toString()) {
				return res.status(403).json({ error: "Insufficient permissions" });
			}

			comment.replies.push({ author: req.user._id, content: content.trim() });
			await comment.save();

			const populated = await populateTaskComment(
				TaskCommentModel.findById(comment._id),
			);

			getIO()?.to(`project:${req.project._id}`).emit("task-reply:added", {
				taskId: req.task._id,
				comment: toTaskCommentResponse(populated, req),
			});

			res.status(201).json({ comment: toTaskCommentResponse(populated, req) });
		} catch (error) {
			res.status(500).json({ error: error.message });
		}
	},
);

taskCommentRouter.delete(
	"/tasks/:taskId/comments/:commentId/replies/:replyId",
	isAuthenticated,
	checkTaskRole("manager", "member"),
	async (req, res) => {
		try {
			const comment = await TaskCommentModel.findOne({
				_id: req.params.commentId,
				task: req.params.taskId,
			});
			if (!comment) return res.status(404).json({ error: "Comment not found" });
			if (comment.project.toString() !== req.project._id.toString()) {
				return res.status(403).json({ error: "Insufficient permissions" });
			}

			const reply = comment.replies.id(req.params.replyId);
			if (!reply) return res.status(404).json({ error: "Reply not found" });

			const isReplyAuthor = reply.author.toString() === req.user._id.toString();
			const isManager = req.projectRole === "manager";
			if (!isReplyAuthor && !isManager) {
				return res.status(403).json({ error: "Not allowed" });
			}

			reply.deleteOne();
			await comment.save();

			const populated = await populateTaskComment(
				TaskCommentModel.findById(comment._id),
			);

			getIO()?.to(`project:${req.project._id}`).emit("task-reply:removed", {
				taskId: req.task._id,
				comment: toTaskCommentResponse(populated, req),
			});

			res.json({ comment: toTaskCommentResponse(populated, req) });
		} catch (error) {
			res.status(500).json({ error: error.message });
		}
	},
);

export default taskCommentRouter;
