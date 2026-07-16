import mongoose from "mongoose";
import { AppError } from "../../../lib/AppError.js";

export class StickyService {
  constructor({ stickyRepository }) {
    this.repo = stickyRepository;
  }

  _parseLabelQuery(labels) {
    if (!labels) return [];
    const values = Array.isArray(labels) ? labels : [labels];
    return values.flatMap((v) => String(v).split(",")).map((v) => v.trim()).filter(Boolean);
  }

  async getWorkspaceStickies(workspaceId, userId, { labels, scope, category, projectId }) {
    const query = { workspace: workspaceId, author: userId };
    const labelIds = this._parseLabelQuery(labels);
    if (labelIds.length > 0) query.labels = { $all: labelIds };
    const hasProjectFilter = projectId && projectId !== "null" && projectId !== "undefined" && projectId !== "";
    if (scope === "project") query.projectId = { $ne: null };
    else if (scope === "workspace" || category === "sticky") query.projectId = null;
    else if (category === "note") query.projectId = { $ne: null };
    if (hasProjectFilter) {
      try { query.projectId = new mongoose.Types.ObjectId(projectId); } catch (e) { query.projectId = new mongoose.Types.ObjectId(); }
    } else if (projectId === "null") { query.projectId = null; }
    return this.repo.find(query);
  }

  async getProjectStickies(projectId, userId, { labels }) {
    const query = { projectId, author: userId };
    const labelIds = this._parseLabelQuery(labels);
    if (labelIds.length > 0) query.labels = { $in: labelIds };
    return this.repo.find(query);
  }

  async createSticky(workspaceId, { title, content, color, labels, position, projectId, parentStickyId }, userId) {
    const isProjectSticky = Boolean(projectId);
    const sticky = await this.repo.create({ title: title || "", content: content || "<p></p>", color: color || "yellow-1", labels: labels || [], position: position || { x: 0, y: 0 }, workspace: workspaceId, author: userId, scope: isProjectSticky ? "project" : "workspace", category: "sticky", projectId: isProjectSticky ? projectId : null });
    if (isProjectSticky && parentStickyId) {
      await this.repo.upsertLink(sticky._id, userId, { workspace: workspaceId, parentSticky: parentStickyId, childSticky: sticky._id, project: projectId, author: userId });
    }
    return sticky;
  }

  async updateSticky(stickyId, updates, userId) {
    const sticky = await this.repo.findById(stickyId);
    if (!sticky) throw new AppError("Sticky not found", 404);
    if (sticky.author.toString() !== userId.toString()) throw new AppError("Access denied", 403);
    const { title, content, color, labels, position, projectId } = updates;
    const updateData = Object.fromEntries(Object.entries({ title, content, color, labels, position, projectId }).filter(([, v]) => v !== undefined));
    updateData.scope = sticky.projectId || projectId ? "project" : "workspace";
    return this.repo.updateById(stickyId, updateData);
  }

  async deleteSticky(stickyId, userId) {
    const sticky = await this.repo.findById(stickyId);
    if (!sticky) throw new AppError("Sticky not found", 404);
    if (sticky.author.toString() !== userId.toString()) throw new AppError("Access denied", 403);
    await this.repo.deleteById(stickyId);
    await this.repo.deleteLinks({ $or: [{ childSticky: sticky._id }, { childNote: sticky._id }, { parentSticky: sticky._id }], author: userId });
  }

  async reorder(stickyIds, userId, scope, scopeId) {
    if (!Array.isArray(stickyIds)) throw new AppError("stickyIds must be an array", 400);
    const ops = stickyIds.map((id, index) => ({ updateOne: { filter: { _id: id, author: userId, ...(scope === "workspace" ? { workspace: scopeId } : { projectId: scopeId }) }, update: { $set: { order: index } } } }));
    if (ops.length > 0) await this.repo.bulkReorder(ops);
  }

  async getChildren(stickyId, userId) {
    const parent = await this.repo.findById(stickyId);
    if (!parent) throw new AppError("Parent sticky not found", 404);
    if (parent.author.toString() !== userId.toString()) throw new AppError("Access denied", 403);
    const links = await this.repo.findLinks(stickyId, userId);
    return links.map((link) => ({ ...link.toObject(), sticky: link.childSticky || link.childNote }));
  }

  async addChild(stickyId, { childStickyId, childNoteId }, userId) {
    const resolvedId = childStickyId || childNoteId;
    const [parentSticky, childSticky] = await Promise.all([this.repo.findById(stickyId), this.repo.findById(resolvedId)]);
    if (!parentSticky) throw new AppError("Parent sticky not found", 404);
    if (!childSticky?.projectId) throw new AppError("Child sticky not found", 404);
    if (parentSticky.author.toString() !== userId.toString() || childSticky.author.toString() !== userId.toString()) throw new AppError("Access denied", 403);
    const link = await this.repo.upsertLink(childSticky._id, userId, { workspace: parentSticky.workspace, parentSticky: parentSticky._id, childSticky: childSticky._id, project: childSticky.projectId, author: userId });
    return { link: { ...link.toObject(), sticky: link.childSticky || link.childNote } };
  }

  async removeChild(stickyId, childStickyId, userId) {
    const link = await this.repo.findLink(stickyId, childStickyId, userId);
    if (!link) throw new AppError("Link not found or no access", 404);
    await this.repo.deleteLinkById(link._id);
  }
}




