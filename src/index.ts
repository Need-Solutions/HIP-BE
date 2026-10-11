import { createServer } from "http";
import { Server } from "socket.io";
import { app, port } from "./app";
import bootstrap from "./bootstrap";
import { allowedOrigins } from "./bootstrap/cors";
import { config } from "./config/config";
import logger from "./utils/logging";

const server = createServer(app);

export const io = new Server(server, {
	cors: { origin: allowedOrigins, credentials: true },
});

async function main() {
	await bootstrap.handleDBConnect();
	server.listen(port, () => {
		logger.general.info(`listening on ${config.apiEndPoint}.`);
	});
}

main().catch(() => {
	process.exit(1);
});
