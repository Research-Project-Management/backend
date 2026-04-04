import mongoose from "mongoose";

const { ObjectId } = mongoose.Schema.Types;

const taskReplySchema = new mongoose.Schema(
	{
		author: { type: ObjectId, ref: "User", required: true },
		content: { type: String, required: true, trim: true, maxlength: 2000 },
	},
	{ timestamps: true },
);

const taskReactionSchema = new mongoose.Schema(
	{
		user: { type: ObjectId, ref: "User", required: true },
		emoji: { type: String, required: true, trim: true, maxlength: 8 },
	},
	{ _id: false },
);

const taskCommentSchema = new mongoose.Schema(
	{
		task: { type: ObjectId, ref: "Task", required: true, index: true },
		project: { type: ObjectId, ref: "Project", required: true, index: true },
		author: { type: ObjectId, ref: "User", required: true, index: true },
		content: { type: String, required: true, trim: true, maxlength: 5000 },
		replies: { type: [taskReplySchema], default: [] },
		reactions: { type: [taskReactionSchema], default: [] },
	},
	{
		timestamps: true,
		minimize: false,
	},
);

taskCommentSchema.index({ task: 1, createdAt: -1 });
taskCommentSchema.index({ project: 1, task: 1, createdAt: -1 });

const TaskCommentModel =
	mongoose.models.TaskComment ||
	mongoose.model("TaskComment", taskCommentSchema);

export default TaskCommentModel;
