import { rateLimit, type AugmentedRequest } from "express-rate-limit";
import { AppError } from "../../../shared/errors/app.error";

export const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  keyGenerator: (_req, res) => res.locals.user.id,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, _res, next) =>
    next(
      new AppError(
        429,
        "rate_limited",
        "You can download your data three times per hour. Please try again later.",
        {
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(
              (((req as AugmentedRequest).rateLimit.resetTime?.getTime() ??
                Date.now() + 3600000) -
                Date.now()) /
                1000,
            ),
          ),
        },
      ),
    ),
});
