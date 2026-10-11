import cookieParser from "cookie-parser";
import express from "express";
import "express-async-errors";
import bootstrap from "./bootstrap";
import { config } from "./config/config";
import { ENV } from "./config/env";

export const app = express();

app.use(express.json());
app.use(cookieParser());

// Handle Important Configs
bootstrap.handleCompression(app);
bootstrap.handleCors(app);
bootstrap.handleSecurity(app);
bootstrap.handleRateLimiting(app);

// All App Routes
bootstrap.handleRoutes(app);

export const port = Number(ENV.PORT) || config.defaults.port;
