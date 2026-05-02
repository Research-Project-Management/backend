import mongoose from "mongoose";

const cycleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },
    startDate: { type: Date },
    endDate: { type: Date },
    status: {
      type: String,
      enum: ["planned", "active", "completed", "cancelled"],
      default: "planned",
    },
    phase: {
      type: String,
      enum: [
        "topic_selection",
        "literature_review",
        "methodology",
        "data_collection",
        "data_analysis",
        "writing",
        "review_revision",
        "submission",
        "custom",
      ],
      default: "custom",
    },
    milestones: [
      {
        title: { type: String, required: true },
        dueDate: { type: Date },
        completed: { type: Boolean, default: false },
      },
    ],
    deliverables: [
      {
        title: { type: String, required: true },
        fileId: { type: mongoose.Schema.Types.ObjectId, ref: "File" },
        completed: { type: Boolean, default: false },
      },
    ],
    labels: [{ type: String }],
    ended_at: { type: Date },
    order: { type: Number, default: 0 },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

const CycleModel =
  mongoose.models.Cycle || mongoose.model("Cycle", cycleSchema);
export default CycleModel;
