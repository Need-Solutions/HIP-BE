import mongoose from "mongoose";
import { ENV } from "../config/env";
import logger from "../utils/logging";

const handleDBConnect = async () => {
	try {
		await mongoose.connect(ENV.MONGODB_URI);
		logger.general.info("connected to database successfully.");
	} catch (err) {
		logger.errors.error(`Database connection error: ${err}`);
		throw err;
	}
};

export default handleDBConnect;
