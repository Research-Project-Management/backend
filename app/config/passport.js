import { Strategy as LocalStrategy } from "passport-local";

import UserModel from "../schema/user.js";

import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as GitHubStrategy } from "passport-github2";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { r2 } from "./r2.js";
import crypto from "crypto";

// Function to download image from URL and upload to R2
async function uploadGoogleAvatarToR2(googleAvatarUrl) {
  try {
    // Download image from Google
    const response = await fetch(googleAvatarUrl);
    if (!response.ok) {
      console.error("Failed to download Google avatar");
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Generate unique filename
    const hash = crypto.randomBytes(16).toString("hex");
    const extension = googleAvatarUrl.includes(".jpg") ? "jpg" : "png";
    const fileName = `avatars/${hash}.${extension}`;

    // Upload to R2
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileName,
      Body: buffer,
      ContentType: `image/${extension}`,
    });

    await r2.send(command);

    // Return proxy URL through backend
    const proxyUrl = `${process.env.API_URL}/api/files/${fileName}`;
    return proxyUrl;
  } catch (error) {
    console.error("Error uploading avatar to R2:", error);
    return null;
  }
}

let initPassportLocal = (passport) => {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.API_URL + "/auth/google/callback",
      },
      async (accessToken, refreshToken, profile, cb) => {
        try {
          let user = await UserModel.findOne({
            email: profile.emails[0].value,
          });
          const googleAvatarUrl = profile.photos?.[0]?.value || null;

          // Upload avatar to R2
          let r2AvatarUrl = null;
          if (googleAvatarUrl) {
            r2AvatarUrl = await uploadGoogleAvatarToR2(googleAvatarUrl);
          }

          if (user == null) {
            // Tạo user mới với avatar từ R2
            let newUser = new UserModel({
              googleId: profile.id,
              name: profile.displayName,
              email: profile.emails[0].value,
              avatar: r2AvatarUrl,
            });
            user = await newUser.save();
          } else {
            // Cập nhật avatar từ R2 nếu chưa có avatar hoặc vẫn dùng avatar của Google
            const shouldUpdateAvatar =
              !user.avatar ||
              (user.avatar && user.avatar.includes("googleusercontent.com"));

            if (r2AvatarUrl && shouldUpdateAvatar) {
              user.avatar = r2AvatarUrl;
              user.googleId = profile.id;
              await user.save();
            }
          }

          return cb(null, user);
        } catch (error) {
          console.error("Error in Google authentication:", error);
          return cb(error, null);
        }
      },
    ),
  );

  passport.use(
    new GitHubStrategy(
      {
        clientID: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        callbackURL: process.env.API_URL + "/auth/github/callback",
      },
      async function (accessToken, refreshToken, profile, done) {
        let user = await UserModel.findOne({ gihubId: profile.id });
        if (user == null) {
          let newUser = new UserModel({
            gihubId: profile.id,
            name: profile.displayName,
          });
          user = await newUser.save();
        }
        return done(null, user);
      },
    ),
  );

  passport.use(
    new LocalStrategy(
      {
        usernameField: "email",
        passwordField: "password",
      },
      async (email, password, done) => {
        try {
          let user = await UserModel.findOne({ email });
          if (!user) {
            return done(null, false);
          }
          if (!user.password) {
            return done(
              {
                type: "ONLY_LOGIN_WITH_OAUTH",
                message: "Please login with your OAuth provider.",
              },
              false,
              null,
            );
          }
          let checkPassword = await user.comparePassword(password);
          if (!checkPassword) {
            return done(
              { type: "INCORRECT_PASSWORD", message: "Incorrect password." },
              false,
              null,
            );
          }
          return done(null, user, {
            type: "LOGIN_SUCCESS",
            message: "Login successful.",
          });
        } catch (error) {
          console.error("Local strategy error:", error);
          return done(
            { type: "NULL_TYPE", message: "Something went wrong." },
            false,
            null,
          );
        }
      },
    ),
  );

  // used to serialize the user for the session
  passport.serializeUser(function (user, done) {
    done(null, user.id);
  });

  // used to deserialize the user
  passport.deserializeUser(async function (id, done) {
    try {
      let user = await UserModel.findOne({ _id: id });
      done(null, user);
    } catch (error) {
      done(error, null);
    }
  });
};

export default initPassportLocal;
