import { createContainer, Lifetime, asClass } from "awilix";
import path from "path";
import { fileURLToPath } from "url";
import fg from "fast-glob";
import { CrossrefClient } from "./lib/crossref.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const container = createContainer();

// Manual registrations
container.register("crossrefClient", asClass(CrossrefClient).singleton());

// Automatically find and register all Repositories, Services, and Controllers using fast-glob
const files = fg.sync([
  "contexts/**/*.repository.js",
  "contexts/**/*.service.js",
  "contexts/**/*.controller.js"
], { cwd: __dirname });

for (const file of files) {
  const modulePath = "./" + file;
  const mod = await import(modulePath);
  
  // Find all classes exported from the module
  const classNames = Object.keys(mod).filter(k => k.endsWith("Repository") || k.endsWith("Service") || k.endsWith("Controller"));
  
  for (const className of classNames) {
    // Convert ClassName to className for DI registration (e.g. PageController -> pageController)
    const registerName = className.charAt(0).toLowerCase() + className.slice(1);
    container.register(registerName, asClass(mod[className]).singleton());
  }
}

// Resolve all controllers so index.js can use them exactly as before
export const authController = container.resolve("authController");

export const workspaceController = container.resolve("workspaceController");
export const projectController = container.resolve("projectController");
export const taskController = container.resolve("taskController");
export const cycleController = container.resolve("cycleController");
export const pageController = container.resolve("pageController");
export const versionController = container.resolve("versionController");
export const latexController = container.resolve("latexController");
export const pageCommentController = container.resolve("pageCommentController");
export const taskCommentController = container.resolve("taskCommentController");
export const stickyController = container.resolve("stickyController");
export const labelController = container.resolve("labelController");
export const fileController = container.resolve("fileController");
export const aiController = container.resolve("aiController");
export const chatHistoryController = container.resolve("chatHistoryController");
export const workspaceCollectionController = container.resolve("workspaceCollectionController");
export const paperController = container.resolve("paperController");
export const projectCollectionController = container.resolve("projectCollectionController");
export const dashboardController = container.resolve("dashboardController");
export default container;
