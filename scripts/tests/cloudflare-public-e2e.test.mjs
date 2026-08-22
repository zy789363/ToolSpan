import assert from "node:assert/strict";
import test from "node:test";

import {
  cloudflaredEnvironment,
  namedTunnelArguments,
  parsePublicCloudflareArguments,
} from "../e2e-cloudflare-public.mjs";

test("public Cloudflare E2E accepts only a sanitized session id", () => {
  assert.deepEqual(parsePublicCloudflareArguments(["--session", "20260823-abcde12345"]), {
    sessionId: "20260823-abcde12345",
  });
  assert.throws(() => parsePublicCloudflareArguments([]), /COMMAND_LINE_ARGUMENT_REJECTED/u);
  assert.throws(() => parsePublicCloudflareArguments(["--session", "../receipt"]), /SESSION_ID_INVALID/u);
});

test("cloudflared receives its token only through the dedicated child environment", () => {
  const token = `eyJ${"a".repeat(80)}`;
  const args = namedTunnelArguments();
  assert.equal(args.some((argument) => argument.includes(token)), false);
  assert.equal(args.includes("--token"), false);
  assert.equal(args.includes("--token-file"), false);
  const environment = cloudflaredEnvironment(token, "C:\\isolated", {
    PATH: "safe",
    TOOLSPAN_E2E_CF_API_TOKEN: "must-not-survive",
  });
  assert.equal(environment.TUNNEL_TOKEN, token);
  assert.equal(environment.TOOLSPAN_E2E_CF_API_TOKEN, undefined);
  assert.equal(environment.HOME, "C:\\isolated");
});
