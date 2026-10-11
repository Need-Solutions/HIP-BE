import { Request } from "express";
import multer, { FileFilterCallback } from "multer";
import path from "path";

// Memory storage keeps the file buffer available for cloud uploads.
const storage = multer.memoryStorage();

const ALLOWED_TYPES: Record<string, string[]> = {
	".jpeg": ["image/jpeg"],
	".jpg": ["image/jpeg"],
	".png": ["image/png"],
	".pdf": ["application/pdf"],
	".txt": ["text/plain"],
	".doc": ["application/msword"],
	".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
	".xls": ["application/vnd.ms-excel"],
	".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
};

// Only images and common document formats are accepted.
const documentFileFilter = (
	req: Request,
	file: Express.Multer.File,
	cb: FileFilterCallback
) => {
	const ext = path.extname(file.originalname).toLowerCase();
	if (ALLOWED_TYPES[ext]?.includes(file.mimetype)) {
		return cb(null, true);
	}
	return cb(new Error("Only images and documents are allowed."));
};

const MEGABYTE = 1024 * 1024;
const MAX_FILE_SIZE_MB = 5;
const limits = { fileSize: MAX_FILE_SIZE_MB * MEGABYTE };

// Images and documents only.
const upload = multer({ storage, fileFilter: documentFileFilter, limits });

// Any file format.
const uploadAny = multer({ storage, limits });

// Kept as aliases for backward compatibility. Use .single() or .array() on either.
const uploadFiles = upload;
const uploadAnyFiles = uploadAny;

export default { upload, uploadFiles, uploadAny, uploadAnyFiles };
