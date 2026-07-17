import { Router } from "express";
import { checkWorkspaceRole } from "../../../middleware/workspace.middleware.js";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { CreateCollectionDto, UpdateCollectionDto } from "./collection.dto.js";

export const buildCollectionRouter = (controller) => {
  const collectionRouter = Router();

  collectionRouter.get(
    "/:workspaceId/collections",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member", "viewer"),
    controller.getCollections
  );

  collectionRouter.get(
    "/project/:projectId/collections",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member", "viewer"), // or checkProjectRole
    controller.getCollections
  );

  collectionRouter.post(
    "/:workspaceId/collections",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(CreateCollectionDto),
    controller.createCollection
  );

  collectionRouter.put(
    "/:workspaceId/collections/:collectionId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(UpdateCollectionDto),
    controller.updateCollection
  );

  collectionRouter.delete(
    "/:workspaceId/collections/:collectionId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    controller.deleteCollection
  );

  return collectionRouter;
};

