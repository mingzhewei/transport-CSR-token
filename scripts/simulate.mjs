#!/usr/bin/env node

/**
 * 模拟仿真：在本机一次性启动
 *   mock-upstream(模拟公司 CRS)  +  internal-bridge(内部电脑)  +  external-client(外部电脑)
 * 用来演示"一台外部电脑通过 internal-bridge 访问大模型"的完整链路，
 * 并验证动态模型映射（外部用别名 gpt-5.5，内部重写为公司真实模型 ID）。
 *
 * 用法: npm run simulate
 * 启动后常驻运行，可在外部电脑视角用 curl 访问 external-client。
 */

import http from "node:http";
import { createInternalBridgeServer } from "../internal-bridge/server.mjs";
import { createExternalClientServer } from "../external-client/server.mjs";
import { sendJSON } from "../shared/proxy.mjs";

const BRIDGE_TOKEN = "test-bridge-token-longer-than-16";
const LOCAL_API_KEY = "test-local-key";

// 模拟公司"经常变更"的真实模型 ID。外部电脑永远只用别名 gpt-5.5。
const COMPANY_REAL_MODEL = "company-gpt-5.5-v3";
const MODEL_MAP = { "gpt-5.5": COMPANY_REAL_MODEL };

const UPSTREAM_PORT = 19000;
const INTERNAL_PORT = 18787;
const EXTERNAL_PORT = 18788;

async function main() {
  const upstream = await listen(
    createMockUpstream(COMPANY_REAL_MODEL),
    "127.0.0.1",
    UPSTREAM_PORT
  );
  const internal = await listen(
    createInternalBridgeServer({
      upstreamBaseURL: `http://127.0.0.1:${UPSTREAM_PORT}/openai`,
      upstreamAPIKey: "test-upstream-key",
      bridgeToken: BRIDGE_TOKEN,
      defaultModel: "gpt-5.5",
      models: ["gpt-5.5"],
      modelMap: MODEL_MAP,
      requestBodyLimitBytes: 1024 * 1024,
      upstreamTimeoutMs: 10000,
      rateLimitRpm: 0,
      logLevel: "info"
    }),
    "127.0.0.1",
    INTERNAL_PORT
  );
  const external = await listen(
    createExternalClientServer({
      remoteBaseURL: `http://127.0.0.1:${INTERNAL_PORT}/openai`,
      bridgeToken: BRIDGE_TOKEN,
      externalAPIKey: LOCAL_API_KEY,
      requestBodyLimitBytes: 1024 * 1024,
      upstreamTimeoutMs: 10000,
      rateLimitRpm: 0,
      logLevel: "info"
    }),
    "127.0.0.1",
    EXTERNAL_PORT
  );

  printBanner();

  await runChecks();

  if (process.env.SIMULATE_ONCE === "1") {
    console.log("\n[simulate] SIMULATE_ONCE=1，验证完成即退出（不常驻）。");
    await close(external).catch(() => {});
    await close(internal).catch(() => {});
    await close(upstream).catch(() => {});
    process.exit(0);
  }

  console.log("\n[simulate] 三个服务已常驻运行，可在外部电脑视角用 curl 访问 external-client：");
  console.log(`  curl http://127.0.0.1:${EXTERNAL_PORT}/healthz`);
  console.log(`  curl http://127.0.0.1:${EXTERNAL_PORT}/openai/models -H "Authorization: Bearer ${LOCAL_API_KEY}"`);
  console.log(`  curl http://127.0.0.1:${EXTERNAL_PORT}/debug/probe -H "Authorization: Bearer ${LOCAL_API_KEY}"`);
  console.log(`  curl http://127.0.0.1:${EXTERNAL_PORT}/openai/responses -H "Content-Type: application/json" -H "Authorization: Bearer ${LOCAL_API_KEY}" -d '{"model":"gpt-5.5","input":"只回复OK"}'`);
  console.log("\n[simulate] 按 Ctrl+C 退出。\n");

  const shutdown = async (signal) => {
    console.error(`\n[simulate] received ${signal}, shutting down...`);
    await close(external).catch(() => {});
    await close(internal).catch(() => {});
    await close(upstream).catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

function printBanner() {
  console.log("=".repeat(76));
  console.log(" 模拟环境已启动：仿真一台外部电脑通过 internal-bridge 访问大模型");
  console.log("=".repeat(76));
  console.log(`  mock-upstream(公司CRS)    http://127.0.0.1:${UPSTREAM_PORT}/openai   真实模型ID=${COMPANY_REAL_MODEL}`);
  console.log(`  internal-bridge(内部电脑) http://127.0.0.1:${INTERNAL_PORT}         映射 gpt-5.5 -> ${COMPANY_REAL_MODEL}`);
  console.log(`  external-client(外部电脑) http://127.0.0.1:${EXTERNAL_PORT}         本地key=${LOCAL_API_KEY}`);
  console.log("  链路: 外部软件 -> external-client -> internal-bridge -> mock-upstream(公司CRS)");
  console.log("-".repeat(76));
  console.log("  说明: 公司变更模型ID时，只需改 internal-bridge 的 MODEL_MAP 配置");
  console.log(`        例如 MODEL_MAP=gpt-5.5=新真实ID，然后重启 internal-bridge。`);
  console.log("        外部电脑、Codex、VSCode 配置完全不用动。");
  console.log("=".repeat(76));
}

async function runChecks() {
  console.log("\n[simulate] 自动验证开始...");
  const checks = [
    step("1. external /healthz", async () => {
      const r = await fetch(`http://127.0.0.1:${EXTERNAL_PORT}/healthz`);
      const j = await r.json();
      assert(r.status === 200 && j.ok, `status=${r.status}`);
      return `ok=${j.ok}`;
    }),
    step("2. /openai/models 应返回别名 gpt-5.5，不暴露真实模型ID", async () => {
      const r = await fetch(`http://127.0.0.1:${EXTERNAL_PORT}/openai/models`, {
        headers: { authorization: `Bearer ${LOCAL_API_KEY}` }
      });
      const j = await r.json();
      const ids = (j.data || []).map((m) => m.id);
      assert(r.status === 200, `status=${r.status}`);
      assert(ids.includes("gpt-5.5"), `models=${ids.join(",")}`);
      assert(!ids.includes(COMPANY_REAL_MODEL), `真实模型ID不应暴露: ${ids.join(",")}`);
      return `models=${ids.join(",")}`;
    }),
    step("3. 非流式 /openai/responses，验证 model 被重写为真实ID", async () => {
      const r = await fetch(`http://127.0.0.1:${EXTERNAL_PORT}/openai/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${LOCAL_API_KEY}` },
        body: JSON.stringify({ model: "gpt-5.5", input: "Say OK" })
      });
      const j = await r.json();
      assert(r.status === 200, `status=${r.status}`);
      assert(j.model === COMPANY_REAL_MODEL, `upstream收到model=${j.model}，期望${COMPANY_REAL_MODEL}`);
      assert(j.output?.[0]?.content?.[0]?.text === "OK", "回答内容不对");
      return `upstream收到model=${j.model}（已从gpt-5.5重写），回答=${j.output?.[0]?.content?.[0]?.text}`;
    }),
    step("4. 流式 /openai/responses", async () => {
      const r = await fetch(`http://127.0.0.1:${EXTERNAL_PORT}/openai/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${LOCAL_API_KEY}` },
        body: JSON.stringify({ model: "gpt-5.5", input: "Say OK", stream: true })
      });
      const text = await r.text();
      assert(r.status === 200, `status=${r.status}`);
      assert(text.includes("response.created"), "缺 response.created");
      assert(text.includes("response.completed"), "缺 response.completed");
      return "流式事件完整";
    }),
    step("5. /debug/probe 外部电脑自测整条链路", async () => {
      const r = await fetch(`http://127.0.0.1:${EXTERNAL_PORT}/debug/probe`, {
        headers: { authorization: `Bearer ${LOCAL_API_KEY}` }
      });
      const j = await r.json();
      assert(r.status === 200, `status=${r.status}（链路应通）`);
      return j.steps.map((s) => `${s.step}=${s.ok ? "ok" : "fail"}`).join(", ");
    }),
    step("6. 未映射的 model 原样透传（映射只影响配置的别名）", async () => {
      const r = await fetch(`http://127.0.0.1:${EXTERNAL_PORT}/openai/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${LOCAL_API_KEY}` },
        body: JSON.stringify({ model: "raw-model-xyz", input: "hi" })
      });
      const j = await r.json();
      assert(r.status === 200, `status=${r.status}`);
      assert(j.model === "raw-model-xyz", `upstream收到model=${j.model}，期望原样透传`);
      return `未映射model原样透传: ${j.model}`;
    })
  ];

  try {
    for (const c of checks) {
      await c;
    }
    console.log("\n[simulate] 自动验证全部通过。");
  } catch (e) {
    console.error(`\n[simulate] 自动验证未全部通过: ${e.message}`);
    console.error("[simulate] 服务仍保持运行，可手动排查。");
  }
}

async function step(name, fn) {
  try {
    const detail = await fn();
    console.log(`  [PASS] ${name}  -> ${detail}`);
  } catch (e) {
    console.error(`  [FAIL] ${name}  -> ${e.message}`);
    throw e;
  }
}

function createMockUpstream(realModel) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock-upstream");

    if (req.headers.authorization !== "Bearer test-upstream-key") {
      sendJSON(res, 401, {
        error: { message: "mock upstream expected upstream key", type: "authentication_error" }
      });
      return;
    }

    if (
      req.method === "GET" &&
      ["/openai/models", "/models", "/v1/models"].includes(url.pathname)
    ) {
      sendJSON(res, 200, {
        object: "list",
        data: [{ id: realModel, object: "model", created: 0, owned_by: "crs" }]
      });
      return;
    }

    if (
      req.method === "POST" &&
      ["/openai/responses", "/responses", "/v1/responses"].includes(url.pathname)
    ) {
      const body = await readBody(req);
      const payload = body ? JSON.parse(body) : {};
      const receivedModel = payload.model; // 回显真实收到的 model，用来验证映射是否生效

      if (payload.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache"
        });
        res.write("event: response.created\n");
        res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_mock", model: receivedModel } })}\n\n`);
        res.write("event: response.output_text.delta\n");
        res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "OK" })}\n\n`);
        res.write("event: response.completed\n");
        res.write(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_mock", status: "completed", model: receivedModel } })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }

      sendJSON(res, 200, {
        id: "resp_mock",
        object: "response",
        model: receivedModel,
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "OK" }]
          }
        ]
      });
      return;
    }

    sendJSON(res, 404, {
      error: { message: `mock upstream has no route for ${req.method} ${url.pathname}`, type: "not_found" }
    });
  });
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
    server.close((error) => (error ? reject(error) : resolve()));
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
