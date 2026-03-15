import mongoose from "mongoose";

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    content: { type: String, default: "" },
    description: { type: String, default: "" },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },
    columnId: { type: String, required: true },
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    dueDate: { type: Date },
    labels: [{ type: String }],
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
    estimate: { type: Number }, // hours
    cycle: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Cycle",
      default: null,
    },
    parentTask: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      default: null,
    },
    identifier: { type: String }, // auto-generated e.g. "PROJ-42"
  },
  { timestamps: true }
);

const TaskModel = mongoose.models.Task || mongoose.model("Task", taskSchema);
export default TaskModel;
