import bcrypt from "bcrypt";
import { promisify } from "util";
import { ENV } from "../../config/env";
import { AdminModel, AdminRole } from "../models/admin.schema";
import logger from "../../utils/logging";

export const AdminSeeder = async () => {
  const email = ENV.SUPER_ADMIN_EMAIL;
  if (!email || (await AdminModel.exists({ email }))) return;
  const passwordHash = await promisify(bcrypt.hash)(
    ENV.SUPER_ADMIN_PASSWORD!,
    12,
  );
  try {
    await AdminModel.updateOne(
      { email },
      {
        $setOnInsert: {
          fullName: ENV.SUPER_ADMIN_NAME,
          email,
          passwordHash,
          role: AdminRole.SUPER_ADMIN,
          status: "active",
          twoStepEnabled: false,
        },
      },
      { upsert: true },
    );
  } catch (err) {
    // Simultaneous server starts may both try the same unique email.
    if (!(err instanceof Error && "code" in err && err.code === 11000))
      throw err;
  }
  logger.general.info("Super admin seeder completed.");
};
