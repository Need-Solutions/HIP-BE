import { createPrivateKey, generateKeyPairSync, randomInt, sign } from "crypto";
import type { ClientSession, Types } from "mongoose";
import { EventSigningKeyModel } from "../../../database/models/event-signing-key.schema";
import { decrypt, encrypt } from "../../../shared/security/encryption";

const CHARACTERS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ticketCode = () => {
  const part = () =>
    Array.from(
      { length: 4 },
      () => CHARACTERS[randomInt(CHARACTERS.length)],
    ).join("");
  return `HIP-${part()}-${part()}`;
};
export async function eventSigningKey(
  eventId: Types.ObjectId,
  session: ClientSession,
) {
  const existing = await EventSigningKeyModel.findOne({ eventId })
    .select("+privateKey")
    .session(session);
  if (existing) return existing;
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyJwk = pair.publicKey.export({ format: "jwk" });
  const privateKey = pair.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const [saved] = await EventSigningKeyModel.create(
    [
      {
        eventId,
        publicKeyJwk,
        privateKey: encrypt(privateKey, `hip:event-key:${eventId}`),
      },
    ],
    { session },
  );
  return saved;
}
export function signTicket(
  code: string,
  eventId: string,
  encryptedKey: string,
) {
  const message = `${code}.${eventId}`;
  const key = createPrivateKey(
    decrypt(encryptedKey, `hip:event-key:${eventId}`),
  );
  const signature = sign("sha256", Buffer.from(message), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${message}.${signature}`;
}
