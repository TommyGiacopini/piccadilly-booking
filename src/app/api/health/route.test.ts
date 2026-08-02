import { describe, expect, it } from "vitest";

import { createHealthResponse } from "@/app/api/health/route";

describe("GET /api/health", () => {
  it("reports an available database without sensitive details", async () => {
    const response = await createHealthResponse(async () => [{ connected: 1 }]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "piccadilly-booking",
      environment: "development",
      database: "ok",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reports a controlled degraded response when the database is unavailable", async () => {
    const response = await createHealthResponse(async () => {
      throw new Error("driver details that must not be returned");
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      status: "degraded",
      service: "piccadilly-booking",
      environment: "development",
      database: "unavailable",
    });
    expect(JSON.stringify(body)).not.toContain("driver details");
  });
});
