import { randomBytes } from "crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ENV } from "../config/env";
import { uploadAvatar, deleteAvatar } from "../services/avatar.service";
const mocks = vi.hoisted(() => ({ upload: vi.fn(), destroy: vi.fn() }));
vi.mock("cloudinary", () => ({
  v2: { uploader: { upload_stream: mocks.upload, destroy: mocks.destroy } },
}));
const original = {
  CLOUDINARY_CLOUD_NAME: ENV.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: ENV.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: ENV.CLOUDINARY_API_SECRET,
};
beforeEach(() => {
  Object.assign(ENV, {
    CLOUDINARY_CLOUD_NAME: "fixture",
    CLOUDINARY_API_KEY: "123456",
    CLOUDINARY_API_SECRET: randomBytes(24).toString("hex"),
  });
  vi.clearAllMocks();
});
afterEach(() => Object.assign(ENV, original));
it("uploads into hip/avatars and returns the secure URL and public ID", async () => {
  mocks.upload.mockImplementation(
    (_options: unknown, callback: (error: null, result: unknown) => void) => ({
      on: vi.fn(),
      end: () =>
        callback(null, {
          secure_url: "https://example.test/avatar.png",
          public_id: "hip/avatars/fixture",
        }),
    }),
  );
  expect(await uploadAvatar(Buffer.from("fixture"))).toEqual({
    url: "https://example.test/avatar.png",
    publicId: "hip/avatars/fixture",
  });
  expect(mocks.upload.mock.calls[0][0]).toMatchObject({
    folder: "hip/avatars",
    resource_type: "image",
    allowed_formats: ["jpg", "png", "webp"],
  });
});
it("does not expose Cloudinary signing diagnostics", async () => {
  mocks.upload.mockImplementation(
    (_options: unknown, callback: (error: Error) => void) => ({
      on: vi.fn(),
      end: () => callback(new Error("Synthetic signing diagnostic")),
    }),
  );
  await expect(uploadAvatar(Buffer.from("fixture"))).rejects.toMatchObject({
    statusCode: 503,
    code: "upload_unavailable",
    message: "We couldn’t upload your photo. Please try again.",
  });
});
it("removes replaced assets and treats a missing asset as already removed", async () => {
  mocks.destroy.mockResolvedValue({ result: "not found" });
  await deleteAvatar("hip/avatars/fixture");
  expect(mocks.destroy.mock.calls[0][0]).toBe("hip/avatars/fixture");
  expect(mocks.destroy.mock.calls[0][1]).toMatchObject({
    invalidate: true,
    resource_type: "image",
  });
});
it("handles deletion failures with a safe message", async () => {
  mocks.destroy.mockRejectedValue(new Error("Synthetic signing diagnostic"));
  await expect(deleteAvatar("hip/avatars/fixture")).rejects.toMatchObject({
    statusCode: 503,
    code: "upload_unavailable",
  });
});
