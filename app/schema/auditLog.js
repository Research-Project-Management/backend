import mongoose from "mongoose";

const auditLogSchema = new mongoose.Schema(
  {
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      required: true,
      index: true,
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    action: {
      type: String,
      enum: [
        "task_created",
        "assignee_added",
        "assignee_removed",
        "assignee_changed",
        "column_moved",
        "attachments_changed",
        "due_date_changed",
        "completed_status_changed",
        "checklist_changed",
      ],
      required: true,
    },
    previous_value: mongoose.Schema.Types.Mixed,
    new_value: mongoose.Schema.Types.Mixed,
    description: String,
  },
  {
    timestamps: true,
  }
);

auditLogSchema.index({ task: 1, createdAt: -1 });
auditLogSchema.index({ project: 1, createdAt: -1 });

const AuditLogModel =
  mongoose.models.AuditLog || mongoose.model("AuditLog", auditLogSchema);

export default AuditLogModel;
