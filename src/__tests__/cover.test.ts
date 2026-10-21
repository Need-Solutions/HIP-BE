import { randomBytes } from "crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ENV } from "../config/env";
import { uploadCover } from "../services/cover.service";

const mocks = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("cloudinary", () => ({
  v2: { uploader: { upload_stream: mocks.upload } },
}));
const previous = {
  CLOUDINARY_CLOUD_NAME: ENV.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: ENV.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: ENV.CLOUDINARY_API_SECRET,
};
beforeEach(() => {
  Object.assign(ENV, {
    CLOUDINARY_CLOUD_NAME: "test-cloud",
    CLOUDINARY_API_KEY: "123456",
    CLOUDINARY_API_SECRET: randomBytes(32).toString("hex"),
  });
  mocks.upload.mockReset();
});
afterEach(() => {
  Object.assign(ENV, previous);
});
it("uploads a buffer as an image and returns only the secure URL", async () => {
  mocks.upload.mockImplementation(
    (
      _options: unknown,
      callback: (error: Error | null, result: { secure_url: string }) => void,
    ) => ({
      on: vi.fn(),
      end: () =>
        callback(null, {
          secure_url: "https://res.cloudinary.com/test/image/upload/cover.png",
        }),
    }),
  );
  expect(await uploadCover(Buffer.from("test image"))).toEqual({
    url: "https://res.cloudinary.com/test/image/upload/cover.png",
  });
  expect(mocks.upload.mock.calls[0][0]).toMatchObject({
    resource_type: "image",
    allowed_formats: ["jpg", "png", "webp"],
    timeout: 30000,
  });
});
it("redacts provider errors, including signing data", async () => {
  mocks.upload.mockImplementation(
    (_options: unknown, callback: (error: Error) => void) => ({
      on: vi.fn(),
      end: () => callback(new Error(ENV.CLOUDINARY_API_SECRET)),
    }),
  );
  await expect(uploadCover(Buffer.from("test"))).rejects.toMatchObject({
    code: "upload_unavailable",
    statusCode: 503,
    message: "We couldn’t upload your cover. Please try again.",
  });
});
it("reports disabled uploads without contacting the provider", async () => {
  ENV.CLOUDINARY_API_SECRET = undefined;
  await expect(uploadCover(Buffer.from("test"))).rejects.toMatchObject({
    code: "upload_unavailable",
    statusCode: 503,
  });
  expect(mocks.upload).not.toHaveBeenCalled();
});
