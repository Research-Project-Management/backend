import { Router } from "express";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";

export const buildReferenceRouter = (referenceController) => {
  const router = Router();

  router.get("/crossref/search", isAuthenticated, referenceController.crossrefSearch);
  router.get(/^\/crossref\/doi\/(.+)/, isAuthenticated, referenceController.crossrefDoi);

  return router;
};
