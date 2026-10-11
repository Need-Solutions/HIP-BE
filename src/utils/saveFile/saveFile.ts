import { promises as fs } from "fs";
import path from "path";

const UPLOADS_DIR = path.join(__dirname, "../../uploads");

// Saves a multer memory-storage file to the local uploads folder.
const saveFile = async (file: Express.Multer.File) => {
	await fs.mkdir(UPLOADS_DIR, { recursive: true });
	const safeName = `${Date.now()}-${path.basename(file.originalname)}`;
	const filePath = path.join(UPLOADS_DIR, safeName);
	await fs.writeFile(filePath, file.buffer);
	return filePath;
};

export default saveFile;
