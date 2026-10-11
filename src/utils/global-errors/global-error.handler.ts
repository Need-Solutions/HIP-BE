import type { ErrorRequestHandler } from "express";
import createHttpError from "http-errors";
import { HttpStatusCode } from "../../shared/enums/http-status-code.tnum";
import logger from "../logging";

// eslint-disable-next-line
const globalErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
	logger.errors.error(err.stack);

	if (createHttpError.isHttpError(err)) {
		return res.status(err.statusCode).json({
			message: err.message,
			success: false,
			status: err.statusCode,
		});
	}

	const fallbackMessage = "An unexpected error occurred";
	const errorMessage =
		typeof err?.message === "string" && err.message.length > 0
			? err.message
			: fallbackMessage;
	const statusCode =
		typeof err?.statusCode === "number"
			? err.statusCode
			: HttpStatusCode.INTERNAL_SERVER_ERROR;

	return res.status(statusCode).json({
		message: errorMessage,
		success: false,
		status: statusCode,
	});
};

export default globalErrorHandler;
