import http from "http";
import express from "express";
import dotenv from "dotenv";
dotenv.config();
import connectDB from "./app/config/db.js";
import { connectRedis, redisClient } from "./app/config/redis.js";
import { initSocket } from "./app/config/socket.js";
import { bindSocketToEventBus } from "./app/lib/eventBus.js";
import { bindCompilerToEventBus } from "./app/contexts/manuscript/latex/latex.subscriber.js";

// ── Contexts & DI Container ──────────────────────────────────────────────────
import * as container from "./app/container.js";

import { buildAuthRouter } from "./app/contexts/identity/auth/auth.route.js";
import { buildWorkspaceRouter } from "./app/contexts/organization/workspace/workspace.route.js";
import { buildProjectRouter } from "./app/contexts/organization/project/project.route.js";
import { buildTaskRouter } from "./app/contexts/planning/task/task.route.js";
import { buildCycleRouter } from "./app/contexts/planning/cycle/cycle.route.js";
import { buildPageRouter } from "./app/contexts/manuscript/page/page.route.js";
import { buildVersionRouter } from "./app/contexts/manuscript/version/version.route.js";
import { buildLatexRouter } from "./app/contexts/manuscript/latex/latex.route.js";
import { buildPageCommentRouter, buildTaskCommentRouter } from "./app/contexts/collaboration/comment/comment.route.js";
import { buildStickyRouter } from "./app/contexts/collaboration/sticky/sticky.route.js";
import { buildLabelRouter } from "./app/contexts/shared/label/label.route.js";
import { buildFileRouter } from "./app/contexts/shared/file/file.route.js";
import { buildAiRouter } from "./app/contexts/intelligence/ai/ai.route.js";
import { buildChatHistoryRouter } from "./app/contexts/intelligence/chat-history/chat-history.route.js";
import { buildCollectionRouter, buildProjectCollectionRouter } from "./app/contexts/library/collection/collection.route.js";
import { buildPaperRouter } from "./app/contexts/library/paper/paper.route.js";
import { buildReferenceRouter } from "./app/contexts/library/reference/reference.route.js";
import { buildDashboardRouter } from "./app/contexts/dashboard/dashboard.route.js";

import session from "express-session";
import { RedisStore } from "connect-redis";
import passport from "passport";
import initPassportLocal from "./app/config/passport.js";
import flash from "express-flash";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { RedisStore as RedisRateLimitStore } from "rate-limit-redis";
import { errorHandler } from "./app/middleware/error.middleware.js";

//config
const PORT = process.env.PORT;
const app = express();
connectDB(process.env.MONGODB_URI);
await connectRedis();
app.set("trust proxy", 1);

//middleware
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: process.env.NODE_ENV === "production" ? 100 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore({ sendCommand: (...args) => redisClient.sendCommand(args) }),
  message: "Too many requests from this IP, please try again later.",
  skip: (req) => req.path.startsWith("/auth/"),
});
app.use(limiter);

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:2915",
      "http://localhost:2916",
      "http://localhost:3000",
      "https://flux.chqv.tech",
      ...(process.env.ORIGINS ? process.env.ORIGINS.split(",").map((o) => o.trim()) : []),
    ],
    credentials: true,
  }),
);

app.use(flash());

const redisStore = new RedisStore({ client: redisClient, prefix: "rpm:sess:", ttl: 7 * 24 * 60 * 60 });

app.use(
  session({
    store: redisStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === "production", sameSite: process.env.NODE_ENV === "production" ? "none" : "lax" },
  }),
);
app.use(passport.initialize());
app.use(passport.session());

initPassportLocal(passport);

//route
app.get("/", (req, res) => { res.json({ message: "Hello bro" }); });

// Identity
app.use("/auth", buildAuthRouter(container.authController));


// Organization
app.use("/api/workspace", buildWorkspaceRouter(container.workspaceController));
app.use("/api", buildProjectRouter(container.projectController));

// Dashboard
app.use("/api/dashboard", buildDashboardRouter(container.dashboardController));

// Planning
app.use("/api", buildTaskRouter(container.taskController));
app.use("/api", buildCycleRouter(container.cycleController));

// Manuscript
app.use("/api", buildPageRouter(container.pageController, container.latexController));
app.use("/api", buildVersionRouter(container.versionController));
app.use("/api/latex", buildLatexRouter(container.latexController));

// Collaboration
app.use("/api", buildPageCommentRouter(container.pageCommentController));
app.use("/api", buildTaskCommentRouter(container.taskCommentController));
app.use("/api", buildStickyRouter(container.stickyController));

// Shared
app.use("/api", buildLabelRouter(container.labelController));
app.use("/api/files", buildFileRouter(
  container.fileController,
  container.workspaceFileController,
  container.projectFileController,
  container.pageFileController
));

// Research
app.use("/api/library", buildCollectionRouter(container.workspaceCollectionController));
app.use("/api/library", buildPaperRouter(container.paperController));
app.use("/api/library", buildProjectCollectionRouter(container.projectCollectionController));
app.use("/api/library/reference", buildReferenceRouter(container.referenceController));

// Intelligence
app.use("/api/ai", buildChatHistoryRouter(container.chatHistoryController));
app.use("/api/ai", buildAiRouter(container.aiController));

// Error handler 
app.use(errorHandler);

//listen
const server = http.createServer(app);
initSocket(server);
bindSocketToEventBus();
bindCompilerToEventBus();
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

// trigger reload
