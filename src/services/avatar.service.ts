import { v2 as cloudinary } from "cloudinary";
import { ENV } from "../config/env";
import { AppError } from "../shared/errors/app.error";

const options = () => {
  if (
    !ENV.CLOUDINARY_CLOUD_NAME ||
    !ENV.CLOUDINARY_API_KEY ||
    !ENV.CLOUDINARY_API_SECRET
  )
    throw new AppError(
      503,
      "upload_unavailable",
      "Photo uploads are not configured.",
    );
  return {
    cloud_name: ENV.CLOUDINARY_CLOUD_NAME,
    api_key: ENV.CLOUDINARY_API_KEY,
    api_secret: ENV.CLOUDINARY_API_SECRET,
  };
};
export async function uploadAvatar(
  buffer: Buffer,
): Promise<{ url: string; publicId: string }> {
  try {
    const config = options();
    return await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          ...config,
          resource_type: "image",
          allowed_formats: ["jpg", "png", "webp"],
          folder: "hip/avatars",
          timeout: 30000,
        },
        (error, result) => {
          if (
            error ||
            !result?.secure_url?.startsWith("https://") ||
            !result.public_id
          )
            return reject(new Error("Upload failed."));
          resolve({ url: result.secure_url, publicId: result.public_id });
        },
      );
      stream.on("error", reject);
      stream.end(buffer);
    });
  } catch {
    throw new AppError(
      503,
      "upload_unavailable",
      "We couldn’t upload your photo. Please try again.",
    );
  }
}
export async function deleteAvatar(publicId: string) {
  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      ...options(),
      resource_type: "image",
      invalidate: true,
    });
    if (result.result !== "ok" && result.result !== "not found")
      throw new Error("Removal failed.");
  } catch {
    throw new AppError(
      503,
      "upload_unavailable",
      "We couldn’t remove your photo. Please try again.",
    );
  }
}
