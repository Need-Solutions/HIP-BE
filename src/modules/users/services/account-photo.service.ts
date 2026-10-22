import { UserModel } from "../../../database/models/users.schema";
import { AppError } from "../../../shared/errors/app.error";
import { transaction } from "../../../shared/database/transaction";
import { uploadAvatar, deleteAvatar } from "../../../services/avatar.service";
import { getProfile } from "./profile.service";
import { queueAccountJob, deliverAccountJob } from "./account-jobs.service";

async function changePhoto(
  userId: string,
  photo?: { url: string; publicId: string },
) {
  return transaction(async (session) => {
    const user = await UserModel.findOneAndUpdate(
      { _id: userId, status: "active" },
      { $inc: { ticketChanges: 1 } },
      { new: true, session },
    ).select("+photoPublicId");
    if (!user)
      throw new AppError(401, "unauthenticated", "Please log in to continue.");
    const old = user.photoPublicId;
    await UserModel.updateOne(
      { _id: userId },
      photo
        ? { $set: { photoUrl: photo.url, photoPublicId: photo.publicId } }
        : { $unset: { photoUrl: 1, photoPublicId: 1 } },
      { session },
    );
    return old
      ? queueAccountJob("remove_photo", { publicId: old }, session)
      : null;
  });
}
export async function uploadPhoto(userId: string, buffer: Buffer) {
  const photo = await uploadAvatar(buffer);
  let cleanup: string | null;
  try {
    cleanup = await changePhoto(userId, photo);
  } catch (error) {
    try {
      await deleteAvatar(photo.publicId);
    } catch {
      /* Do not expose provider errors. */
    }
    throw error;
  }
  if (cleanup) await deliverAccountJob(cleanup);
  return getProfile(userId);
}
export async function removePhoto(userId: string) {
  const cleanup = await changePhoto(userId);
  if (cleanup) await deliverAccountJob(cleanup);
  return getProfile(userId);
}
