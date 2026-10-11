import handleCompression from "./compression";
import handleCors from "./cors";
import handleRateLimiting from "./rate-limiting";
import { handleRoutes } from "./routes";
import handleSecurity from "./security";
import handleDBConnect from "./database";

export default {
	handleRoutes,
	handleCompression,
	handleCors,
	handleRateLimiting,
	handleSecurity,
	handleDBConnect
};
