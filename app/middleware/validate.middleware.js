import { AppError } from "../lib/AppError.js";

export const validate = (schema) => async (req, res, next) => {
  try {
    if (schema.body) {
      req.body = await schema.body.parseAsync(req.body);
    }
    if (schema.query) {
      req.query = await schema.query.parseAsync(req.query);
    }
    if (schema.params) {
      req.params = await schema.params.parseAsync(req.params);
    }
    return next();
  } catch (error) {
    if (error.name === "ZodError") {
      const details = error.errors.map((e) => ({
        path: e.path.join("."),
        message: e.message,
      }));
      const appError = new AppError("Validation Failed", 400, "VALIDATION_ERROR");
      appError.details = details;
      return next(appError);
    }
    return next(error);
  }
};
