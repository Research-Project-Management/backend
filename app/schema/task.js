import mongoose from "mongoose";

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    content: { type: String, default: "" },
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
    columnId: { type: String, required: true }, // ref to project.taskColumns.id
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    dueDate: { type: Date },
    labels: [{ type: String }],
    rank: { type: Number, default: 0 }, // For ordering within column
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

const TaskModel = mongoose.models.Task || mongoose.model("Task", taskSchema);
export default TaskModel;
