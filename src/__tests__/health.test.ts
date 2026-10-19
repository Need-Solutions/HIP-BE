import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../app";

describe("GET /api/health", () => {
  it("returns 200 and a success payload", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
  });

  it("returns 404 for unknown routes", async () => {
    const res = await request(app).get("/does-not-exist");
    expect(res.status).toBe(404);
  });
});
