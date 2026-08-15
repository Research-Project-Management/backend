import { Router } from "express";
import { checkWorkspaceRole } from "../../../middleware/workspace.middleware.js";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { CreateCollectionDto, UpdateCollectionDto } from "./collection.dto.js";

export const buildCollectionRouter = (controller) => {
  const router = Router();

  // Modern RESTful endpoints (mounted at /api/library/collections)
  router.get(
    "/:workspaceId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member", "viewer"),
    controller.getCollections
  );

  router.post(
    "/:workspaceId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(CreateCollectionDto),
    controller.createCollection
  );

  router.get(
    "/:workspaceId/:collectionId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member", "viewer"),
    controller.getCollectionById
  );

  router.put(
    "/:workspaceId/:collectionId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(UpdateCollectionDto),
    controller.updateCollection
  );

  router.delete(
    "/:workspaceId/:collectionId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    controller.deleteCollection
  );

  // Legacy route aliases (for backward compatibility when mounted at /api/library)
  router.get(
    "/:workspaceId/collections",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member", "viewer"),
    controller.getCollections
  );

  router.post(
    "/:workspaceId/collections",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(CreateCollectionDto),
    controller.createCollection
  );

  router.put(
    "/:workspaceId/collections/:collectionId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(UpdateCollectionDto),
    controller.updateCollection
  );

  router.delete(
    "/:workspaceId/collections/:collectionId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    controller.deleteCollection
  );

  return router;
};
