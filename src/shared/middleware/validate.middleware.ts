import type { RequestHandler } from "express";
import type { ZodTypeAny } from "zod";
import { AppError } from "../errors/app.error";

export const validate =
  (
    schema: ZodTypeAny,
    source: "body" | "params" | "query" = "body",
  ): RequestHandler =>
  (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const issue = result.error.issues[0];
      next(
        new AppError(400, "validation_error", issue.message, {
          field: issue.path.length ? issue.path.join(".") : undefined,
        }),
      );
      return;
    }
    req[source] = result.data;
    next();
  };
