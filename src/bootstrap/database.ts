import mongoose from "mongoose";
import { ENV } from "../config/env";
import logger from "../utils/logging";
import { UserModel } from "../database/models/users.schema";
import { VerificationCodeModel } from "../database/models/verification-code.schema";
import { PasswordResetModel } from "../database/models/password-reset.schema";
import { LoginAttemptModel } from "../database/models/login-attempt.schema";
import { ContactChangeModel } from "../database/models/contact-change.schema";
import { AdminModel } from "../database/models/admin.schema";
import { StaffChallengeModel } from "../database/models/staff-challenge.schema";

const handleDBConnect = async () => {
  try {
    await mongoose.connect(ENV.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
    });
    await Promise.all([
      UserModel.init(),
      VerificationCodeModel.init(),
      PasswordResetModel.init(),
      LoginAttemptModel.init(),
      ContactChangeModel.init(),
      AdminModel.init(),
      StaffChallengeModel.init(),
    ]);
    logger.general.info("connected to database successfully.");
  } catch (err) {
    logger.errors.error("Database connection failed.");
    throw err;
  }
};

export default handleDBConnect;
