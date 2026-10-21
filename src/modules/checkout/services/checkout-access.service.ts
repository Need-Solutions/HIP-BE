import { createHash, randomBytes } from "crypto";
import type { Request, Response } from "express";
import { cookieOptions } from "../../users/services/auth-session.service";

export const CHECKOUT_COOKIE = "hip_checkout";
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export interface CheckoutViewer {
  ownerHash?: string;
  userId?: string;
}
export function checkoutViewer(
  req: Request,
  res: Response,
  create = false,
): CheckoutViewer {
  let token: unknown = req.cookies?.[CHECKOUT_COOKIE];
  if (typeof token !== "string" || !/^[a-f\d]{64}$/.test(token))
    token = undefined;
  if (!token && create) {
    token = randomBytes(32).toString("hex");
    res.cookie(CHECKOUT_COOKIE, token, {
      ...cookieOptions,
      maxAge: 30 * 86400000,
    });
  }
  return {
    ownerHash: typeof token === "string" ? hashToken(token) : undefined,
    userId: res.locals.user?.id,
  };
}
export function viewerFilter(viewer: CheckoutViewer) {
  return {
    $or: [
      ...(viewer.ownerHash ? [{ ownerHash: viewer.ownerHash }] : []),
      ...(viewer.userId ? [{ buyerUserId: viewer.userId }] : []),
      // A missing session must never turn into an unrestricted query.
      { _id: null },
    ],
  };
}
