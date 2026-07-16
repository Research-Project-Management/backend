import request from "supertest";
import UserModel from "../../app/contexts/identity/auth/auth.schema.js";

// Note: To make this work, index.js should export the app instance.
// But assuming it doesn't, we will import the main Express app, or we will set it up manually.
// For now, let's assume we create a test app or refactor index.js slightly if needed.
// Actually, let's create a test app instance here to avoid side effects if index.js calls app.listen() directly.

import express from "express";
import session from "express-session";
import passport from "passport";
import { buildAuthRouter } from "../../app/contexts/identity/auth/auth.route.js";
import { AuthController } from "../../app/contexts/identity/auth/auth.controller.js";
import { AuthService } from "../../app/contexts/identity/auth/auth.service.js";
import { AuthRepository } from "../../app/contexts/identity/auth/auth.repository.js";
import { errorHandler } from "../../app/middleware/error.middleware.js";

let testApp;

beforeAll(() => {
  testApp = express();
  testApp.use(express.json());
  testApp.use(
    session({
      secret: "test-secret",
      resave: false,
      saveUninitialized: false,
    })
  );
  testApp.use(passport.initialize());
  testApp.use(passport.session());

  // Manually mock passport serialize/deserialize if needed for full integration,
  // but for registration we just hit the controller directly.

  const authRepository = new AuthRepository();
  const authService = new AuthService({ authRepository });
  const authController = new AuthController({ authService });
  const authRouter = buildAuthRouter(authController);

  testApp.use("/api/auth", authRouter);
  testApp.use(errorHandler);
});

describe("Auth Integration Tests", () => {
  const testUser = {
    name: "Test User",
    email: "test@example.com",
    password: "Password123!"
  };

  afterEach(async () => {
    await UserModel.deleteMany({});
  });

  describe("POST /api/auth/register", () => {
    it("should register a new user successfully", async () => {
      const response = await request(testApp)
        .post("/api/auth/register")
        .send(testUser);

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty("user");
      expect(response.body.user.email).toBe(testUser.email);
      expect(response.body.user).not.toHaveProperty("password");

      // Verify in DB
      const dbUser = await UserModel.findOne({ email: testUser.email });
      expect(dbUser).not.toBeNull();
      expect(dbUser.name).toBe(testUser.name);
    });

    it("should return 400 if email already exists", async () => {
      await request(testApp).post("/api/auth/register").send(testUser);

      const response = await request(testApp)
        .post("/api/auth/register")
        .send(testUser);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty("error");
      expect(response.body.error).toContain("already in use");
    });
  });

  // To test login properly with passport-local, we need to ensure passport is fully configured
  // For the sake of this test, we can mock it or configure a local strategy manually.
  // In a real app, you'd extract passport setup to a separate module and import it here.
});
