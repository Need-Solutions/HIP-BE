import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		watch: false,
		root: ".",
		reporters: ["default"],
		env: { MONGODB_URI: "mongodb://localhost:27017/test", NODE_ENV: "test" },
	},
});
