#!/usr/bin/env node

import http from "node:http";
import { createInternalBridgeServer } from "../internal-bridge/server.mjs";
import { createExternalClientServer } from "../external-client/server.mjs";
import { createRateLimiter } from "../shared/rate-limit.mjs";
import { sendJSON } from "../shared/proxy.mjs";

const BRIDGE_TOKEN = "test-bridge-token-longer-than-16";
const LOCAL_API_KEY = "test-local-key";

async function main() {
  const upstream = await listen(createMockUpstream(), "127.0.0.1", 19000);
  const internal = await listen(createInternalBridgeServer({
    upstreamBaseURL: "http://127.0.0.1:19000/openai",
    upstreamAPIKey: "test-upstream-key",
    bridgeToken: BRIDGE_TOKEN,
    defaultModel: "gpt-5.5",
    models: ["gpt-5.5"],
    requestBodyLimitBytes: 1024 * 1024,
    upstreamTimeoutMs: 5000,
    rateLimitRpm: 0
  }), "127.0.0.1", 18787);
  const external = await listen(createExternalClientServer({
    remoteBaseURL: "http://127.0.0.1:18787/openai",
    bridgeToken: BRIDGE_TOKEN,
    externalAPIKey: LOCAL_API_KEY,
    requestBodyLimitBytes: 1024 * 1024,
    upstreamTimeoutMs: 5000,
    rateLimitRpm: 0
  }), "127.0.0.1", 18788);

  try {
    await checkHealth();
    await checkCORS();
    await checkModels();
    await checkNonStream();
    await checkStream();
    await checkExternalAuthFailure();
    await checkBridgeAuthFailure();
    await checkRateLimiter();
    console.log("smoke:local ok");
  } finally {
    await close(external);
    await close(internal);
    await close(upstream);
  }
}

function createMockUpstream() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock-upstream");

    if (req.headers.authorization !== "Bearer test-upstream-key") {
      sendJSON(res, 401, {
        error: {
          message: "mock upstream expected upstream key",
          type: "authentication_error"
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/openai/responses") {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      if (payload.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache"
        });
        res.write("event: response.created\n");
        res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_mock", model: payload.model } })}\n\n`);
        res.write("event: response.output_text.delta\n");
        res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "OK" })}\n\n`);
        res.write("event: response.completed\n");
        res.write(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_mock", status: "completed" } })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }

      sendJSON(res, 200, {
        id: "resp_mock",
        object: "response",
        model: payload.model,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "OK"
              }
            ]
          }
        ]
      });
      return;
    }

    sendJSON(res, 404, {
      error: {
        message: `mock upstream has no route for ${req.method} ${url.pathname}`,
        type: "not_found"
      }
    });
  });
}

async function checkHealth() {
  const response = await fetch("http://127.0.0.1:18788/healthz");
  const payload = await response.json();
  assert(response.status === 200 && payload.ok, "external health check failed");
  assert(!("remote_base_url" in payload), "healthz leaks remote_base_url");
}

async function checkCORS() {
  const response = await fetch("http://127.0.0.1:18788/openai/responses", {
    method: "OPTIONS",
    headers: {
      origin: "http://example.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type"
    }
  });
  assert(response.status === 204, "CORS preflight status failed");
  assert(
    response.headers.get("access-control-allow-origin") === "http://example.com",
    "CORS allow-origin failed"
  );
  assert(
    (response.headers.get("access-control-allow-methods") || "").includes("POST"),
    "CORS allow-methods failed"
  );
}

async function checkModels() {
  const response = await fetch("http://127.0.0.1:18788/openai/models", {
    headers: {
      authorization: `Bearer ${LOCAL_API_KEY}`
    }
  });
  const payload = await response.json();
  assert(response.status === 200, "models status failed");
  assert(payload.data?.[0]?.id === "gpt-5.5", "models payload failed");
}

async function checkNonStream() {
  const response = await fetch("http://127.0.0.1:18788/openai/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${LOCAL_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-5.5",
      input: "Say OK"
    })
  });
  const payload = await response.json();
  assert(response.status === 200, "non-stream status failed");
  assert(payload.output?.[0]?.content?.[0]?.text === "OK", "non-stream payload failed");
}

async function checkStream() {
  const response = await fetch("http://127.0.0.1:18788/openai/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${LOCAL_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-5.5",
      input: "Say OK",
      stream: true
    })
  });

  const text = await response.text();
  assert(response.status === 200, "stream status failed");
  assert(response.headers.get("content-type")?.includes("text/event-stream"), "stream content-type failed");
  assert(text.includes("response.created"), "stream did not include response.created");
  assert(text.includes("response.completed"), "stream did not include response.completed");
}

async function checkExternalAuthFailure() {
  const response = await fetch("http://127.0.0.1:18788/openai/models", {
    headers: {
      authorization: "Bearer wrong-local-key"
    }
  });
  assert(response.status === 401, "external auth failure should return 401");
}

async function checkBridgeAuthFailure() {
  const response = await fetch("http://127.0.0.1:18787/openai/models", {
    headers: {
      authorization: "Bearer wrong-bridge-token"
    }
  });
  assert(response.status === 401, "bridge auth failure should return 401");
}

async function checkRateLimiter() {
  const limiter = createRateLimiter({ capacity: 2, windowMs: 1000 });
  assert(limiter.allow("a").allowed, "rate limit first request");
  assert(limiter.allow("a").allowed, "rate limit second request");
  assert(!limiter.allow("a").allowed, "rate limit third request should be blocked");
  assert(limiter.allow("b").allowed, "rate limit other key should be allowed");
  limiter.stop();
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
