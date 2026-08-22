import request from "supertest";
import { describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http-app.js";
import { SERVICE_INFO } from "../src/service-info.js";

describe("health endpoint", () => {
  it("reports a healthy service without exposing configuration secrets", async () => {
    const response = await request(createHttpApp({ instanceName: "home-build-pc" }))
      .get("/healthz")
      .expect(200);

    expect(response.body).toEqual({
      status: "ok",
      service: SERVICE_INFO.service,
      version: SERVICE_INFO.version,
    });
    expect(response.body).not.toHaveProperty("instanceName");
    expect(JSON.stringify(response.body)).not.toContain("password");
    expect(JSON.stringify(response.body)).not.toContain("token");
  });
});
