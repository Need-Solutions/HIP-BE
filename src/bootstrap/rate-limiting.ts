import { Application } from "express";
import { rateLimit } from "express-rate-limit";

const SECOND_IN_MILLISECONDS = 1000;
const MINUTE_IN_SECONDS = 60;
const WINDOW_IN_MINUTES = 15;
const WINDOW_MS = WINDOW_IN_MINUTES * MINUTE_IN_SECONDS * SECOND_IN_MILLISECONDS;
const MAX_REQUESTS_PER_WINDOW = 100;

const limiter = rateLimit({
	windowMs: WINDOW_MS,
	limit: MAX_REQUESTS_PER_WINDOW,
	standardHeaders: true,
	legacyHeaders: false,
});

const handleRateLimiting = (app: Application) => {
	app.use(limiter);
};

export default handleRateLimiting;
