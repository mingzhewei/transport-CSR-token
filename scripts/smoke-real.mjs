#!/usr/bin/env node

/**
 * 真实端到端测试：本机同时模拟"内部电脑(internal-bridge)"和"外部电脑(external-client)"。
 * internal-bridge 直连真实公司 CRS，用 .env 里的真实 API key。
 * 从"外部电脑"视角发真实请求，验证整条链路。
 *
 * 用法: node scripts/smoke-real.mjs
 * 注意：会真实调用公司大模型，消耗 API 额度。
 */

import { loadDotEnv, normalizeBaseURL, optionalEnv, requiredEnv } from "../shared/config.mjs";
import { createInternalBridgeServer } from "../internal-bridge/server.mjs";
import { createExternalClientServer } from "../external-client/server.mjs";

const INTERNAL_PORT = 28787;
const EXTERNAL_PORT = 28788;
const LOCAL_API_KEY = "realtest-local-key-2026";

main().catch((e) => {
  console.error("\n[smoke-real] 测试脚本异常:", e);
  process.exitCode = 1;
});

async function main() {
  loadDotEnv();
  const upstreamBaseURL = normalizeBaseURL(requiredEnv("UPSTREAM_BASE_URL"), "UPSTREAM_BASE_URL");
  const upstreamAPIKey = requiredEnv("UPSTREAM_API_KEY");
  const defaultModel = optionalEnv("DEFAULT_MODEL", "gpt-5.5");
  const bridgeToken = resolveBridgeToken();

  printBanner(upstreamBaseURL, upstreamAPIKey, defaultModel, bridgeToken);

  const internal = await listen(
    createInternalBridgeServer({
      upstreamBaseURL,
      upstreamAPIKey,
      bridgeToken,
      defaultModel,
      models: [defaultModel],
      requestBodyLimitBytes: 25 * 1024 * 1024,
      upstreamTimeoutMs: 120_000,
      rateLimitRpm: 0,
      logLevel: "warn"
    }),
    "127.0.0.1",
    INTERNAL_PORT
  );
  const external = await listen(
    createExternalClientServer({
      remoteBaseURL: `http://127.0.0.1:${INTERNAL_PORT}/openai`,
      bridgeToken,
      externalAPIKey: LOCAL_API_KEY,
      requestBodyLimitBytes: 25 * 1024 * 1024,
      upstreamTimeoutMs: 120_000,
      rateLimitRpm: 0,
      logLevel: "warn"
    }),
    "127.0.0.1",
    EXTERNAL_PORT
  );

  const results = [];
  const base = `http://127.0.0.1:${EXTERNAL_PORT}`;
  const auth = { authorization: `Bearer ${LOCAL_API_KEY}` };

  try {
    await run("1. external /healthz", () => checkHealth(base), results);
    await run("2. internal /healthz（直连内部电脑）", () => checkHealth(`http://127.0.0.1:${INTERNAL_PORT}`), results);
    await run("3. external /openai/models", () => checkModels(base, auth), results);
    await run("4. external /debug/probe（链路自测）", () => checkDebugProbe(base, auth), results);
    await run(`5. 非流式真实问答 model=${defaultModel}`, () => checkNonStream(base, auth, defaultModel), results);
    await run(`6. 流式真实问答 model=${defaultModel}`, () => checkStream(base, auth, defaultModel), results);
    await run("7. 错误本地 key 应返回 401", () => checkWrongLocalKey(base), results);
    await run("8. 错误 model 名，观察 upstream 错误", () => checkWrongModel(base, auth), results);
  } finally {
    await close(external).catch(() => {});
    await close(internal).catch(() => {});
  }

  printSummary(results);
  const failed = results.filter((r) => !r.ok).length;
  process.exit(failed > 0 ? 1 : 0);
}

function resolveBridgeToken() {
  const raw = process.env.BRIDGE_TOKEN || "";
  const isWeak = !raw || raw.length < 16 || /^\d{6,}$/.test(raw) ||
    /^password$/i.test(raw) || /^12345678/.test(raw) ||
    /^abcdefg/i.test(raw) || /^bridge-token/i.test(raw);
  if (!isWeak) {
    return raw;
  }
  return "realtest-bridge-token-0123456789abcdef";
}

function printBanner(upstreamBaseURL, upstreamAPIKey, defaultModel, bridgeToken) {
  const fromEnv = bridgeToken === process.env.BRIDGE_TOKEN;
  console.log("=".repeat(78));
  console.log(" 真实端到端测试：外部电脑 → external-client → internal-bridge → 真实公司 CRS");
  console.log("=".repeat(78));
  console.log(`  真实上游        ${upstreamBaseURL}`);
  console.log(`  真实 API key    ${maskKey(upstreamAPIKey)}`);
  console.log(`  默认模型        ${defaultModel}`);
  console.log(`  桥接 token      ${fromEnv ? "(来自.env)" : "(临时值,.env的" + (process.env.BRIDGE_TOKEN || "") + "不合规)"}`);
  console.log(`  本地 key        ${LOCAL_API_KEY}`);
  console.log(`  internal-bridge http://127.0.0.1:${INTERNAL_PORT}`);
  console.log(`  external-client http://127.0.0.1:${EXTERNAL_PORT}`);
  console.log("-".repeat(78));
  console.log("  说明: 此测试会真实调用公司大模型，消耗 API 额度。");
  console.log("=".repeat(78));
}

async function run(name, fn, results) {
  process.stdout.write(`\n▶ ${name} ... `);
  const t0 = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - t0;
    console.log(`PASS (${ms}ms)`);
    if (detail) console.log(`  ${detail}`);
    results.push({ name, ok: true, ms, detail });
  } catch (e) {
    const ms = Date.now() - t0;
    console.log(`FAIL (${ms}ms)`);
    console.log(`  X ${e.message}`);
    results.push({ name, ok: false, ms, detail: e.message });
  }
}

async function checkHealth(base) {
  const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) });
  const j = await r.json();
  assert(r.status === 200, `status=${r.status}`);
  assert(j.ok === true, `ok=${j.ok}`);
  return `service=${j.service}, default_model=${j.default_model || "(n/a)"}`;
}

async function checkModels(base, auth) {
  const r = await fetch(`${base}/openai/models`, { headers: auth, signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  assert(r.status === 200, `status=${r.status} body=${JSON.stringify(j).slice(0, 200)}`);
  const ids = (j.data || []).map((m) => m.id);
  assert(ids.length > 0, "models 为空");
  return `models=[${ids.join(", ")}]`;
}

async function checkDebugProbe(base, auth) {
  const r = await fetch(`${base}/debug/probe`, { headers: auth, signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  const steps = (j.steps || []).map((s) => `${s.step}=${s.ok ? "ok" : "FAIL"}`).join(", ");
  assert(r.status === 200, `probe 返回 ${r.status}，链路有问题`);
  return steps;
}

async function checkNonStream(base, auth, model) {
  const r = await fetch(`${base}/openai/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ model, input: "只回复两个字：可以" }),
    signal: AbortSignal.timeout(120000)
  });
  const text = await r.text();
  let detail = `status=${r.status} ct=${r.headers.get("content-type")}`;
  try {
    const j = JSON.parse(text);
    const out = extractOutputText(j);
    detail += ` | model=${j.model || "(n/a)"} | 回答=${out ? JSON.stringify(out) : "(未能提取)"}`;
  } catch {
    detail += ` | body=${text.slice(0, 300)}`;
  }
  assert(r.status === 200, `status=${r.status} body=${text.slice(0, 300)}`);
  return detail;
}

async function checkStream(base, auth, model) {
  const r = await fetch(`${base}/openai/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ model, input: "只回复两个字：可以", stream: true }),
    signal: AbortSignal.timeout(120000)
  });
  assert(r.status === 200, `status=${r.status}`);
  assert((r.headers.get("content-type") || "").includes("event-stream"), `ct=${r.headers.get("content-type")}`);

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let fullText = "";
  let firstChunkAt = 0;
  const t0 = Date.now();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstChunkAt === 0) firstChunkAt = Date.now() - t0;
    const piece = decoder.decode(value, { stream: true });
    chunks.push({ ms: Date.now() - t0, len: value.length });
    fullText += piece;
  }

  const eventTypes = [...fullText.matchAll(/^event:\s*(.+)$/gm)].map((m) => m[1].trim());
  const deltas = [...fullText.matchAll(/^data:\s*(.+)$/gm)]
    .map((m) => m[1].trim())
    .filter((d) => d.includes("delta"));

  return `首块=${firstChunkAt}ms 总块=${chunks.length} 耗时=${Date.now() - t0}ms 事件=[${eventTypes.join(",")}] delta块=${deltas.length}`;
}

async function checkWrongLocalKey(base) {
  const r = await fetch(`${base}/openai/models`, {
    headers: { authorization: "Bearer wrong-key" },
    signal: AbortSignal.timeout(5000)
  });
  assert(r.status === 401, `期望401, 实际=${r.status}`);
  return `status=401 (正确拒绝)`;
}

async function checkWrongModel(base, auth) {
  const r = await fetch(`${base}/openai/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ model: "this-model-does-not-exist-xyz", input: "hi" }),
    signal: AbortSignal.timeout(30000)
  });
  const text = await r.text();
  return `status=${r.status} (upstream对错误model的响应) body=${text.slice(0, 200)}`;
}

function extractOutputText(j) {
  try {
    return j.output?.[0]?.content?.[0]?.text ||
      j.output?.[0]?.content?.[0]?.output_text ||
      j.choices?.[0]?.message?.content ||
      "";
  } catch {
    return "";
  }
}

function printSummary(results) {
  console.log("\n" + "=".repeat(78));
  console.log(" 测试汇总");
  console.log("=".repeat(78));
  for (const r of results) {
    const mark = r.ok ? "PASS" : "FAIL";
    console.log(`  [${mark}] ${r.name} (${r.ms}ms)`);
    if (!r.ok) console.log(`         ${r.detail}`);
  }
  const passed = results.filter((r) => r.ok).length;
  console.log("-".repeat(78));
  console.log(`  通过 ${passed}/${results.length}`);
  console.log("=".repeat(78));
}

function maskKey(k) {
  if (!k) return "(empty)";
  if (k.length <= 10) return k.slice(0, 3) + "***";
  return k.slice(0, 6) + "..." + k.slice(-4);
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
