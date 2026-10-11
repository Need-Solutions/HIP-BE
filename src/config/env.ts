import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const MAX_PORT_RANGE = 65536;
const envSchema = z.object({
	NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
	PORT: z
		.string()
		.refine(
			(value) => {
				const port = parseInt(value, 10);
				return !isNaN(port) && port > 0 && port < MAX_PORT_RANGE;
			},
			{ message: "Port is Invalid." }
		)
		.optional(),
	MONGODB_URI: z.string().min(1, "MONGODB_URI is required."),
	CORS_ORIGINS: z.string().optional(),

	// Add more environment variables and their validation rules here as needed
});

type Env = z.infer<typeof envSchema>;

export const ENV: Env = envSchema.parse(process.env);
