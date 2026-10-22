import { Types, type ClientSession } from "mongoose";
import { AccountJobModel } from "../../../database/models/account-job.schema";
import { encrypt, decrypt } from "../../../shared/security/encryption";
import { sendMail } from "../../../services/mail.service";
import { deleteAvatar } from "../../../services/avatar.service";

type Mail = { to: string; subject: string; text: string };
export async function queueAccountJob(
  kind: "mail" | "remove_photo",
  value: Mail | { publicId: string },
  session: ClientSession,
) {
  const id = new Types.ObjectId();
  await AccountJobModel.create(
    [
      {
        _id: id,
        kind,
        payload: encrypt(JSON.stringify(value), `hip:account-job:${id}`),
      },
    ],
    { session },
  );
  return id.toString();
}
export async function deliverAccountJob(id: string) {
  const now = new Date();
  const job = await AccountJobModel.findOneAndUpdate(
    {
      _id: id,
      state: "pending",
      retryAt: { $lte: now },
      $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }],
    },
    { $set: { leaseUntil: new Date(Date.now() + 120000) } },
    { new: true },
  ).select("+payload");
  if (!job) return;
  try {
    const value = JSON.parse(
      decrypt(job.payload, `hip:account-job:${job.id}`),
    ) as Mail & { publicId: string };
    if (job.kind === "mail")
      await sendMail({
        to: value.to,
        subject: value.subject,
        text: value.text,
      });
    else await deleteAvatar(value.publicId);
    await AccountJobModel.updateOne(
      { _id: job._id, leaseUntil: job.leaseUntil },
      { $set: { state: "done" }, $unset: { payload: 1, leaseUntil: 1 } },
    );
  } catch {
    // Retry without logging recipient, asset identifiers or provider signing parameters.
    await AccountJobModel.updateOne(
      { _id: job._id, leaseUntil: job.leaseUntil },
      {
        $set: { retryAt: new Date(Date.now() + 60000) },
        $unset: { leaseUntil: 1 },
      },
    );
  }
}
export function startAccountMaintenance() {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      const jobs = await AccountJobModel.find({
        state: "pending",
        retryAt: { $lte: new Date() },
      }).limit(50);
      for (const job of jobs) await deliverAccountJob(job.id);
    } catch {
      /* The next pass retries; no private payloads are logged. */
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    void run();
  }, 30000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
