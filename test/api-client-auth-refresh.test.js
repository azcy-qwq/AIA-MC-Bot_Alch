import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Agent } from "../base.js";

test("parallel requests share one reauthentication after an expired API token", async () => {
  let logins = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/v1/auth/login") {
      logins++;
      res.end(JSON.stringify({ ok: true, token: "fresh-token" }));
      return;
    }
    if (req.headers.authorization !== "Bearer fresh-token") {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: { code: "invalid_token", message: "token not found or expired" } }));
      return;
    }
    res.end(JSON.stringify({ ok: true, result: { ready: true, body: body || null } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const client = new Agent("Alch", "test-password", { baseUrl: `http://127.0.0.1:${port}/api/v1`, token: "expired-token" });
    const results = await Promise.all([
      client.status(),
      client.inventory(),
      client.request("/dig", { method: "POST", body: { pos: [1, 2, 3] } })
    ]);
    assert.equal(logins, 1);
    assert.equal(client.token, "fresh-token");
    assert.equal(results.length, 3);
    assert.ok(results.every(result => result.ok));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

