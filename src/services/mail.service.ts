import nodemailer from "nodemailer";
import { ENV } from "../config/env";
import { AppError } from "../shared/errors/app.error";
import logger from "../utils/logging";

const transport = nodemailer.createTransport({
  host: ENV.SMTP_HOST,
  port: ENV.SMTP_PORT,
  secure: ENV.SMTP_PORT === 465,
  auth: ENV.SMTP_USER
    ? { user: ENV.SMTP_USER, pass: ENV.SMTP_PASS }
    : undefined,
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 10000,
  logger: false,
  debug: false,
});

export const sendMail = async (message: {
  to: string;
  subject: string;
  text: string;
}) => {
  try {
    await transport.sendMail({ from: ENV.MAIL_FROM, ...message });
  } catch {
    logger.errors.error("Mail delivery failed.");
    throw new AppError(
      503,
      "mail_unavailable",
      "We couldn’t send your email. Please try again shortly.",
    );
  }
};
