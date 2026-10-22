// Never inherit a developer's fixed code in the test environment.
import { vi } from "vitest";
// Tests use generated configuration from vitest.config.mjs, never a developer's .env file.
vi.mock("dotenv", () => ({ default: { config: () => ({}) } }));
delete process.env.DEV_FIXED_CODE;
