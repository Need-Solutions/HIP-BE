import { format, transports } from "winston";
const { combine, timestamp, printf } = format;

const customFormat = printf(
	({ level, message, timestamp }) => `${timestamp} [${level}]: ${message}`
);

const consoleTransport = new transports.Console({
	level: 'debug', // Set the log level to 'info'
	format: combine(timestamp(), customFormat),
});

export { consoleTransport };
