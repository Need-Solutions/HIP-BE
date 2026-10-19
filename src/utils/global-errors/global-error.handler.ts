import type { ErrorRequestHandler } from "express";
import { mongo } from "mongoose";
import { HttpStatusCode } from "../../shared/enums/http-status-code.enum";
import { AppError } from "../../shared/errors/app.error";
import logger from "../logging";

const globalErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  let error: AppError;
  if (err instanceof AppError) {
    error = err;
  } else if (err instanceof mongo.MongoServerError && err.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0];
    error =
      field === "email" || field === "phone"
        ? new AppError(
            409,
            `${field}_taken`,
            `An account with this ${field === "phone" ? "phone number" : "email"} already exists.`,
            { field },
          )
        : new AppError(
            409,
            "conflict",
            "This request conflicts with an existing record.",
          );
  } else if (err?.type === "entity.parse.failed") {
    error = new AppError(400, "validation_error", "Invalid JSON request body.");
  } else if (err?.type === "entity.too.large") {
    error = new AppError(
      413,
      "validation_error",
      "The request body is too large.",
    );
  } else {
    // Raw errors may contain passwords, tokens, connection strings or SMTP credentials.
    logger.errors.error("Unhandled request error.", { method: req.method });
    error = new AppError(
      HttpStatusCode.INTERNAL_SERVER_ERROR,
      "internal_error",
      "An unexpected error occurred",
    );
  }
  res
    .status(error.statusCode)
    .json({
      ...error.details,
      message: error.message,
      success: false,
      status: error.statusCode,
      code: error.code,
    });
};

export default globalErrorHandler;
