import mongoose from "mongoose";

const checklistItemSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    completed: { type: Boolean, default: false },
    assigneeId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    dueDate: { type: Date },
  },
  { _id: true },
);

const checklistSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    items: { type: [checklistItemSchema], default: [] },
  },
  { _id: true },
);

const attachmentSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, default: "" },
    size: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
    url: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    content: { type: String, default: "" },
    description: { type: String, default: "" },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    columnId: { type: String, required: true, trim: true, index: true },
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    startDate: { type: Date },
    dueDate: { type: Date },
    recurrence: {
      type: String,
      enum: ["none", "daily", "mon-fri", "weekly", "monthly-day", "monthly-week"],
      default: "none",
    },
    reminder: {
      type: String,
      enum: ["none", "at-time", "5m", "10m", "15m", "1h", "2h", "1day", "2day"],
      default: "1day",
    },
    labels: { type: [String], default: [] },
    rank: { type: Number, default: 0 },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    priority: {
      type: String,
      enum: ["urgent", "high", "medium", "low", "none"],
      default: "none",
    },
    estimate: { type: Number, min: 0 },
    cycle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Cycle",
      default: null,
      index: true,
    },
    parentTask: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      default: null,
    },
    identifier: { type: String, trim: true },
    checklists: { type: [checklistSchema], default: [] },
    completed: { type: Boolean, default: false },
    attachments: { type: [attachmentSchema], default: [] },
  },
  {
    timestamps: true,
    minimize: false,
  },
);

taskSchema.index({ project: 1, columnId: 1, rank: 1 });
taskSchema.index({ project: 1, assignee: 1, dueDate: 1 });
taskSchema.index(
  { project: 1, identifier: 1 },
  { unique: true, sparse: true },
);

const TaskModel = mongoose.models.Task || mongoose.model("Task", taskSchema);
export default TaskModel;
