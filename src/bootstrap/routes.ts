import { Application } from "express";
import globalErrorHandler from "../utils/global-errors/global-error.handler";

const handleRoutes = (app: Application) => {
	// health check
	app.get("/health", (req, res) => {
		res.status(200).json({
			status: "success",
			message: "Server is up and running",
		});
	});

	// Mount module routes here, e.g.:
	// app.use(`/api/v${config.defaults.version}/users`, userRoutes);

	app.use(globalErrorHandler);
};

export { handleRoutes };
