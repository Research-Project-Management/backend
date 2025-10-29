import { Strategy as LocalStrategy } from "passport-local";

import UserModel from "../schema/user.js";

import { Strategy as GoogleStrategy } from "passport-google-oauth20";

let initPassportLocal = (passport) => {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: "http://localhost:2912/auth/google/callback",
      },
      async (accessToken, refreshToken, profile, cb) => {
        console.log("Google profile: ", profile);
        let user = await UserModel.findOne({ email: profile.emails[0].value });
        if (user == null) {
          let newUser = new UserModel({
            googleId: profile.id,
            name: profile.displayName,
            email: profile.emails[0].value,
          });
          user = await newUser.save();
        }
        console.log("Google user authenticated: ", user.email);
        return cb(null, user);
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
        //console.log(email, password);

        try {
          let user = await UserModel.findOne({ email });
          if (!user) {
            console.log(email, password);
            return done(null, false);
          }
          if (!user.password) {
            return done(
              {
                type: "ONLY_LOGIN_WITH_GOOGLE",
                message: "Please login with Google",
              },
              false,
              null,
            );
          }
          let checkPassword = await user.comparePassword(password);
          if (!checkPassword) {
            console.log("Incorrect password - ", user.email);
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
          console.log(error);
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
      console.log(id);
      let user = await UserModel.findOne({ _id: id });
      done(null, user);
    } catch (error) {
      done(error, null);
    }
  });
};

export default initPassportLocal;
