import { Router } from "express";
import { checkProjectRole } from "../../../middleware/project.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { CreateProjectCollectionDto, ImportLibraryCollectionDto, AddPaperToProjectCollectionDto } from "./project-collection.dto.js";

export const buildProjectCollectionRouter = (controller) => {
  const pcRouter = Router();

  pcRouter.get(
    "/project/:projectId/collections",
    checkProjectRole("manager", "member", "viewer"),
    controller.getProjectCollections
  );

  pcRouter.post(
    "/project/:projectId/collections",
    checkProjectRole("manager", "member"),
    validate(CreateProjectCollectionDto),
    controller.createProjectCollection
  );

  pcRouter.post(
    "/project/:projectId/collections/:pcId/import-library",
    checkProjectRole("manager", "member"),
    validate(ImportLibraryCollectionDto),
    controller.importLibraryCollection
  );

  pcRouter.post(
    "/project/:projectId/collections/:pcId/papers",
    checkProjectRole("manager", "member"),
    validate(AddPaperToProjectCollectionDto),
    controller.addPaperToProjectCollection
  );

  pcRouter.delete(
    "/project/:projectId/collections/:pcId/papers/:paperId",
    checkProjectRole("manager", "member"),
    controller.removePaperFromProjectCollection
  );

  pcRouter.delete(
    "/project/:projectId/collections/:pcId",
    checkProjectRole("manager"),
    controller.deleteProjectCollection
  );

  return pcRouter;
};

