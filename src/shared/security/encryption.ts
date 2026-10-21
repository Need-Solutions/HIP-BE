import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { ENV } from "../../config/env";

// The purpose binds ciphertext to its record, separate from staff authenticator encryption.
export function encrypt(value: string, purpose: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(ENV.ENCRYPTION_KEY, "hex"),
    iv,
  );
  cipher.setAAD(Buffer.from(purpose));
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    bytes.toString("hex"),
  ].join(":");
}
export function decrypt(value: string, purpose: string) {
  const [version, iv, tag, bytes, extra] = value.split(":");
  if (
    version !== "v1" ||
    extra !== undefined ||
    !/^[a-f0-9]{24}$/.test(iv) ||
    !/^[a-f0-9]{32}$/.test(tag) ||
    !/^(?:[a-f0-9]{2})+$/.test(bytes)
  )
    throw new Error("Invalid encrypted value.");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(ENV.ENCRYPTION_KEY, "hex"),
    Buffer.from(iv, "hex"),
  );
  cipher.setAAD(Buffer.from(purpose));
  cipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    cipher.update(Buffer.from(bytes, "hex")),
    cipher.final(),
  ]).toString("utf8");
}
