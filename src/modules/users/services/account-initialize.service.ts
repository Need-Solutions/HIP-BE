import { UserModel } from "../../../database/models/users.schema";
import { RefundRequestModel } from "../../../database/models/refund-request.schema";
import { CheckInModel } from "../../../database/models/check-in.schema";
import { AccountJobModel } from "../../../database/models/account-job.schema";

export async function initializeAccount() {
  await Promise.all([
    UserModel.init(),
    RefundRequestModel.init(),
    CheckInModel.init(),
    AccountJobModel.init(),
  ]);
  // Create the replacement first, so email uniqueness is never unenforced during migration.
  await UserModel.collection.createIndex(
    { email: 1 },
    {
      name: "user_email_unique",
      unique: true,
      partialFilterExpression: { email: { $type: "string" } },
    },
  );
  const indexes = await UserModel.collection.indexes();
  const legacy = indexes.find(
    (i) => i.name === "email_1" && i.unique && !i.partialFilterExpression,
  );
  if (legacy) await UserModel.collection.dropIndex("email_1");
}
