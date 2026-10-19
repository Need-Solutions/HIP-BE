import { Application } from "express";
import { rateLimit, type AugmentedRequest } from "express-rate-limit";
import { AppError } from "../shared/errors/app.error";

const SECOND_IN_MILLISECONDS = 1000;
const MINUTE_IN_SECONDS = 60;
const WINDOW_IN_MINUTES = 15;
const WINDOW_MS =
  WINDOW_IN_MINUTES * MINUTE_IN_SECONDS * SECOND_IN_MILLISECONDS;
const MAX_REQUESTS_PER_WINDOW = 100;

export const limiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: MAX_REQUESTS_PER_WINDOW,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next) => {
    const resetTime =
      (req as AugmentedRequest).rateLimit.resetTime?.getTime() ??
      Date.now() + WINDOW_MS;
    next(
      new AppError(
        429,
        "rate_limited",
        "Too many requests. Please try again later.",
        {
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((resetTime - Date.now()) / SECOND_IN_MILLISECONDS),
          ),
        },
      ),
    );
  },
});

const handleRateLimiting = (app: Application) => {
  app.use(limiter);
};

export default handleRateLimiting;
