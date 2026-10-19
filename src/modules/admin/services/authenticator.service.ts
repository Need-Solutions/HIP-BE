import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";
import { ENV } from "../../../config/env";

const key = Buffer.from(ENV.ENCRYPTION_KEY, "hex");
const AAD = Buffer.from("hip:staff:authenticator:v1");

export const encryptSecret = (secret: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
};

export const decryptSecret = (value: string) => {
  const [version, iv, tag, encrypted, extra] = value.split(":");
  if (
    version !== "v1" ||
    extra !== undefined ||
    !/^[a-f0-9]{24}$/.test(iv) ||
    !/^[a-f0-9]{32}$/.test(tag) ||
    !/^(?:[a-f0-9]{2})+$/.test(encrypted)
  ) {
    throw new Error("Invalid authenticator secret.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "hex")),
    decipher.final(),
  ]).toString("utf8");
};

export const newAuthenticatorSecret = () => generateSecret();
export const authenticatorCodeValid = async (encrypted: string, code: string) =>
  (
    await verify({
      secret: decryptSecret(encrypted),
      token: code,
      epochTolerance: 30,
    })
  ).valid;

export const authenticatorSetupResponse = async (
  encrypted: string,
  email: string,
) => {
  const setupKey = decryptSecret(encrypted);
  const uri = generateURI({ issuer: "HIP", label: email, secret: setupKey });
  return { qrCode: await QRCode.toDataURL(uri), setupKey };
};
