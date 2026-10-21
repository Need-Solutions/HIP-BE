import type { RequestHandler } from "express";
import multer from "multer";
import path from "path";
import { AppError } from "../../../shared/errors/app.error";

export const MAX_COVER_BYTES = 5 * 1024 * 1024;
const formats: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const invalidImage = () =>
  new AppError(400, "invalid_file_type", "Choose a JPG, PNG or WebP image.", {
    field: "image",
  });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_COVER_BYTES, files: 1, fields: 0 },
  fileFilter: (_req, file, done) => {
    if (
      formats[path.extname(file.originalname).toLowerCase()] !==
        file.mimetype ||
      !Object.values(formats).includes(file.mimetype)
    )
      return done(invalidImage());
    done(null, true);
  },
}).single("image");

export const coverUpload: RequestHandler = (req, res, next) => {
  upload(req, res, (error) => {
    if (error instanceof multer.MulterError)
      return next(
        new AppError(
          error.code === "LIMIT_FILE_SIZE" ? 413 : 400,
          error.code === "LIMIT_FILE_SIZE"
            ? "file_too_large"
            : "validation_error",
          error.code === "LIMIT_FILE_SIZE"
            ? "Choose an image no larger than 5 MB."
            : "Upload one image in the image field.",
          { field: "image" },
        ),
      );
    if (error) return next(error instanceof AppError ? error : invalidImage());
    const file = req.file;
    if (!file)
      return next(
        new AppError(400, "validation_error", "Choose a cover image.", {
          field: "image",
        }),
      );
    // Check the content too; extension and Content-Type are controlled by the caller.
    const bytes = file.buffer;
    const jpeg =
      bytes.length > 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff;
    const png =
      bytes.length > 8 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const webp =
      bytes.length > 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP";
    if (
      !(
        (file.mimetype === "image/jpeg" && jpeg) ||
        (file.mimetype === "image/png" && png) ||
        (file.mimetype === "image/webp" && webp)
      )
    )
      return next(invalidImage());
    next();
  });
};
