import { createHmac, randomInt } from "crypto";
import { ENV } from "../../../config/env";
import { sendMail } from "../../../services/mail.service";
import { AppError } from "../../../shared/errors/app.error";

export const CODE_ATTEMPTS = 5;
export const RESEND_SECONDS = 60;
export const CODE_TTL_MS = 10 * 60 * 1000;
export type CodeChannel = "email" | "phone";

export const generateCode = () =>
  ENV.NODE_ENV === "development" && ENV.DEV_FIXED_CODE
    ? ENV.DEV_FIXED_CODE
    : randomInt(0, 1000000).toString().padStart(6, "0");

export const hashCode = (id: string, code: string) =>
  createHmac("sha256", ENV.JWT_SECRET).update(`${id}:${code}`).digest("hex");

export const assertCodeDelivery = (channel: CodeChannel) => {
  if (channel === "phone" && ENV.NODE_ENV !== "development") {
    throw new AppError(
      503,
      "sms_unavailable",
      "Phone verification is not available yet. Please use email.",
    );
  }
};

export const deliverCode = async (
  destination: string,
  channel: CodeChannel,
  code: string,
) => {
  assertCodeDelivery(channel);
  if (channel === "email") {
    await sendMail({
      to: destination,
      subject: "Your HIP verification code",
      text: `Your HIP verification code is ${code}. It expires in 10 minutes.`,
    });
    return;
  }
  // TODO(Termii): deliver phone codes with Termii. Development only until then.
  console.warn(`[DEV SMS] HIP verification code: ${code}`);
};
