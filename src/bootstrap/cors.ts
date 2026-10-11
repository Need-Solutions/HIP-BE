import cors, { CorsOptions } from "cors";
import { Application } from "express";
import { ENV } from "../config/env";

const allowedOrigins = ENV.CORS_ORIGINS
	? ENV.CORS_ORIGINS.split(",").map((origin) => origin.trim())
	: true;

// `origin: true` reflects the request origin. A literal "*" is rejected by
// browsers when credentials are enabled.
const corsOptions: CorsOptions = {
	credentials: true,
	origin: allowedOrigins,
	methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
	allowedHeaders: ["Content-Type", "Authorization"],
};

const handleCors = (app: Application) => {
	app.use(cors(corsOptions));
};

export { allowedOrigins };
export default handleCors;
