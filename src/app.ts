import cookieParser from "cookie-parser";
import express from "express";
import "express-async-errors";
import bootstrap from "./bootstrap";
import { config } from "./config/config";
import { ENV } from "./config/env";

export const app = express();

// Paystack signs exact bytes. Capture them before JSON parsing, including whitespace.
app.use(
  "/api/webhooks/paystack",
  express.raw({ type: "application/json", limit: "100kb" }),
);
app.use((req, res, next) =>
  req.path === "/api/webhooks/paystack"
    ? next()
    : express.json()(req, res, next),
);
app.use(cookieParser());

// Handle Important Configs
bootstrap.handleCompression(app);
bootstrap.handleCors(app);
bootstrap.handleSecurity(app);
bootstrap.handleRateLimiting(app);

// All App Routes
bootstrap.handleRoutes(app);

export const port = Number(ENV.PORT) || config.defaults.port;
