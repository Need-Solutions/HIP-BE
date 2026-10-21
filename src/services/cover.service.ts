import { v2 as cloudinary } from "cloudinary";
import { ENV } from "../config/env";
import { AppError } from "../shared/errors/app.error";

// https://cloudinary.com/documentation/node_image_and_video_upload#the_upload_stream_method
export async function uploadCover(buffer: Buffer): Promise<{ url: string }> {
  if (
    !ENV.CLOUDINARY_CLOUD_NAME ||
    !ENV.CLOUDINARY_API_KEY ||
    !ENV.CLOUDINARY_API_SECRET
  )
    throw new AppError(
      503,
      "upload_unavailable",
      "Cover uploads are not configured.",
    );
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          cloud_name: ENV.CLOUDINARY_CLOUD_NAME,
          api_key: ENV.CLOUDINARY_API_KEY,
          api_secret: ENV.CLOUDINARY_API_SECRET,
          resource_type: "image",
          allowed_formats: ["jpg", "png", "webp"],
          folder: "hip/events",
          timeout: 30000,
        },
        (error, result) => {
          if (
            error ||
            !result?.secure_url ||
            !result.secure_url.startsWith("https://")
          )
            return reject(new Error("Cover upload failed."));
          resolve(result.secure_url);
        },
      );
      stream.on("error", reject);
      stream.end(buffer);
    });
    return { url };
  } catch {
    // Cloudinary errors can include signing parameters. Keep them out of responses and logs.
    throw new AppError(
      503,
      "upload_unavailable",
      "We couldn’t upload your cover. Please try again.",
    );
  }
}
