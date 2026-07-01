#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadDotEnv,
  normalizeBaseURL,
  optionalEnv,
  parseIntegerEnv,
  parseListenAddr,
  requiredEnv,
  validateBridgeToken
} from "../shared/config.mjs";
import {
  createServer,
  getBearerToken,
  handleCORS,
  proxyRequest,
  requireBearer,
  sendJSON
} from "../shared/proxy.mjs";
import { createLogger } from "../shared/logger.mjs";
import { createRateLimiter, rateLimitResponse } from "../shared/rate-limit.mjs";

export function createExternalClientServer(config) {
  const logger = config.logger || createLogger({
    service: "external-client",
    level: config.logLevel,
    logFile: config.logFile
  });

  const rateLimiter = createRateLimiter({
    capacity: config.rateLimitRpm,
    windowMs: 60_000
  });

  const recentErrors = createRecentErrorsBuffer(50);

  const server = createServer(async (req, res) => {
    if (handleCORS(req, res)) {
      return;
    }

    const requestURL = new URL(req.url, "http://external-client");
    const clientKey = req.socket.remoteAddress || getBearerToken(req) || "unknown";
    const limit = rateLimiter.allow(clientKey);
    if (!limit.allowed) {
      logger.warn("rate_limit_exceeded", {
        request_id: req.requestId,
        client: clientKey,
        retry_after_ms: limit.resetMs
      });
      rateLimitResponse(res, limit.resetMs);
      return;
    }

    if (req.method === "GET" && requestURL.pathname === "/healthz") {
      sendJSON(res, 200, {
        ok: true,
        service: "external-client",
        local_auth_required: Boolean(config.externalAPIKey)
      });
      return;
    }

    if (config.externalAPIKey && !requireBearer(req, config.externalAPIKey)) {
      logger.warn("local_auth_failed", {
        request_id: req.requestId,
        method: req.method,
        path: requestURL.pathname
      });
      sendJSON(res, 401, {
        error: {
          message: "Missing or invalid local API key",
          type: "authentication_error"
        }
      });
      return;
    }

    // ===== 调试端点（受 EXTERNAL_API_KEY 保护）=====
    if (req.method === "GET" && requestURL.pathname.startsWith("/debug")) {
      if (requestURL.pathname === "/debug/probe") {
        await handleDebugProbe(res, config, logger, recentErrors);
        return;
      }
      if (requestURL.pathname === "/debug/recent-errors") {
        sendJSON(res, 200, {
          service: "external-client",
          count: recentErrors.list().length,
          errors: recentErrors.list()
        });
        return;
      }
      sendJSON(res, 404, {
        error: {
          message: `Unknown debug path: ${requestURL.pathname}`,
          type: "not_found",
          hint: "Available: GET /debug/probe, GET /debug/recent-errors"
        }
      });
      return;
    }

    await proxyRequest(req, res, {
      targetBaseURL: config.remoteBaseURL,
      authorizationToken: config.bridgeToken,
      requestBodyLimitBytes: config.requestBodyLimitBytes,
      upstreamTimeoutMs: config.upstreamTimeoutMs,
      logPrefix: "external-client",
      logger,
      onErrorHint: ({ isAbort }) => buildErrorHint(isAbort),
      onError: ({ isAbort, status, error }) => {
        recentErrors.push({ event: "upstream_error", isAbort, status, error });
      }
    });
  }, { logger, service: "external-client" });

  server._cleanup = () => {
    rateLimiter.stop();
    return logger.close();
  };

  return server;
}

export function loadExternalConfig() {
  loadDotEnv();
  const bridgeToken = optionalEnv("BRIDGE_TOKEN", "");
  const externalAPIKey = optionalEnv("EXTERNAL_API_KEY", "");
  return {
    remoteBaseURL: normalizeBaseURL(requiredEnv("REMOTE_BASE_URL"), "REMOTE_BASE_URL"),
    bridgeToken,
    externalAPIKey,
    listenAddr: optionalEnv("EXTERNAL_LISTEN_ADDR", "127.0.0.1:18788"),
    requestBodyLimitBytes: parseIntegerEnv("REQUEST_BODY_LIMIT_BYTES", 25 * 1024 * 1024),
    upstreamTimeoutMs: parseIntegerEnv("UPSTREAM_TIMEOUT_MS", 120_000),
    rateLimitRpm: parseIntegerEnv("RATE_LIMIT_RPM", 60),
    logLevel: optionalEnv("LOG_LEVEL", "info"),
    logFile: optionalEnv("LOG_FILE", "")
  };
}

export function startExternalClient(config = loadExternalConfig()) {
  const logger = config.logger || createLogger({
    service: "external-client",
    level: config.logLevel,
    logFile: config.logFile
  });
  config.logger = logger;

  validateBridgeToken(config.bridgeToken, { logger });

  if (!config.externalAPIKey) {
    logger.warn("local_auth_disabled", {
      message: "EXTERNAL_API_KEY is empty. Any local process on this machine can use the model bridge. Set EXTERNAL_API_KEY on shared machines."
    });
  }

  const server = createExternalClientServer(config);
  const { host, port } = parseListenAddr(config.listenAddr);

  server.once("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`[external-client] failed to listen on ${host}:${port}: address already in use. Change EXTERNAL_LISTEN_ADDR or stop the process using this port.`);
      process.exitCode = 1;
      return;
    }
    console.error(`[external-client] server error: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    logger.info("server_listening", {
      listen_url: `http://${host}:${port}`,
      local_auth_required: Boolean(config.externalAPIKey),
      log_file: config.logFile || ""
    });
  });

  setupGracefulShutdown(server, "external-client");
  return server;
}

/**
 * 从外部电脑视角自测整条链路：自己 -> internal-bridge /healthz -> internal-bridge /openai/models。
 * 一次调用就能定位"断在哪一跳"。
 */
async function handleDebugProbe(res, config, logger, recentErrors) {
  const steps = [];
  const rootBase = String(config.remoteBaseURL).replace(/\/(openai|v1)$/, "");
  const authHeaders = config.bridgeToken
    ? { authorization: `Bearer ${config.bridgeToken}` }
    : {};

  steps.push({ step: "external-client(self)", ok: true, status: 200, duration_ms: 0 });

  // 第 2 跳：internal-bridge /healthz
  try {
    const url = `${rootBase}/healthz`;
    const t0 = Date.now();
    const resp = await fetch(url, {
      headers: authHeaders,
      signal: AbortSignal.timeout(8000)
    });
    steps.push({
      step: "internal-bridge /healthz",
      ok: resp.ok,
      status: resp.status,
      duration_ms: Date.now() - t0,
      url
    });
  } catch (e) {
    steps.push({
      step: "internal-bridge /healthz",
      ok: false,
      error: e.message,
      url: `${rootBase}/healthz`
    });
  }

  // 第 3 跳：internal-bridge /openai/models（验证桥接 token + 模型列表）
  try {
    const url = `${rootBase}/openai/models`;
    const t0 = Date.now();
    const resp = await fetch(url, {
      headers: authHeaders,
      signal: AbortSignal.timeout(8000)
    });
    let preview = "";
    try {
      preview = (await resp.text()).slice(0, 200);
    } catch {
      // ignore
    }
    steps.push({
      step: "internal-bridge /openai/models",
      ok: resp.ok,
      status: resp.status,
      duration_ms: Date.now() - t0,
      url,
      preview
    });
  } catch (e) {
    steps.push({
      step: "internal-bridge /openai/models",
      ok: false,
      error: e.message,
      url: `${rootBase}/openai/models`
    });
  }

  const ok = steps.every((s) => s.ok);
  recentErrors.push({
    event: "debug_probe",
    ok,
    steps: steps.map((s) => ({ step: s.step, ok: s.ok, status: s.status }))
  });
  logger.info("debug_probe", { ok, steps: steps.map((s) => `${s.step}=${s.ok}`) });
  sendJSON(res, ok ? 200 : 502, { ok, service: "external-client", steps });
}

function buildErrorHint(isAbort) {
  if (isAbort) {
    return "internal-bridge 未在超时内响应。排查: (1) internal-bridge 是否在运行; (2) 两台机器 Tailscale 是否在线; (3) UPSTREAM_TIMEOUT_MS 是否过小。调用 GET /debug/probe 定位。";
  }
  return "无法连接 internal-bridge。排查: (1) REMOTE_BASE_URL 是否指向 internal-bridge 的 Tailscale 地址; (2) 两台机器 Tailscale 是否在线; (3) BRIDGE_TOKEN 是否一致; (4) internal-bridge 是否在运行。调用 GET /debug/probe 定位。";
}

function createRecentErrorsBuffer(max = 50) {
  const errors = [];
  return {
    push(entry) {
      errors.push({ ts: new Date().toISOString(), ...entry });
      while (errors.length > max) {
        errors.shift();
      }
    },
    list() {
      return errors.slice();
    }
  };
}

function setupGracefulShutdown(server, service) {
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error(`[${service}] received ${signal}, shutting down gracefully...`);

    server.close((error) => {
      if (error) {
        console.error(`[${service}] error closing server: ${error.message}`);
      }
    });

    try {
      await server._cleanup?.();
    } catch (error) {
      console.error(`[${service}] cleanup error: ${error.message}`);
    }

    setTimeout(() => {
      process.exit(0);
    }, 5000).unref?.();
  }

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  try {
    startExternalClient();
  } catch (error) {
    console.error(`[external-client] failed to start: ${error.message}`);
    process.exitCode = 1;
  }
}

function isDirectRun(moduleURL, argvPath) {
  if (!argvPath) {
    return false;
  }
  try {
    return fs.realpathSync(fileURLToPath(moduleURL)) === fs.realpathSync(path.resolve(argvPath));
  } catch {
    return fileURLToPath(moduleURL) === path.resolve(argvPath);
  }
}
