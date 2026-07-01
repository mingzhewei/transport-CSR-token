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
  parseModelMapEnv,
  parseModelsEnv,
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

export function createInternalBridgeServer(config) {
  const logger = config.logger || createLogger({
    service: "internal-bridge",
    level: config.logLevel,
    logFile: config.logFile
  });

  const rateLimiter = createRateLimiter({
    capacity: config.rateLimitRpm,
    windowMs: 60_000
  });

  const server = createServer(async (req, res) => {
    if (handleCORS(req, res)) {
      return;
    }

    const requestURL = new URL(req.url, "http://internal-bridge");
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
        service: "internal-bridge",
        default_model: config.defaultModel,
        model_map_enabled: Object.keys(config.modelMap || {}).length > 0
      });
      return;
    }

    if (!requireBearer(req, config.bridgeToken)) {
      logger.warn("bridge_auth_failed", {
        request_id: req.requestId,
        method: req.method,
        path: requestURL.pathname
      });
      sendJSON(res, 401, {
        error: {
          message: "Missing or invalid bridge token",
          type: "authentication_error"
        }
      });
      return;
    }

    if (req.method === "GET" && isModelsPath(requestURL.pathname)) {
      // 有模型映射时，对外只暴露别名，不暴露公司真实模型 ID。
      const listedModels = Object.keys(config.modelMap || {}).length
        ? Object.keys(config.modelMap)
        : config.models;
      sendJSON(res, 200, {
        object: "list",
        data: listedModels.map((id) => ({
          id,
          object: "model",
          created: 0,
          owned_by: "crs"
        }))
      });
      return;
    }

    await proxyRequest(req, res, {
      targetBaseURL: config.upstreamBaseURL,
      authorizationToken: config.upstreamAPIKey,
      requestBodyLimitBytes: config.requestBodyLimitBytes,
      upstreamTimeoutMs: config.upstreamTimeoutMs,
      logPrefix: "internal-bridge",
      logger,
      rewriteBody: createModelRewriter(config.modelMap)
    });
  }, { logger, service: "internal-bridge" });

  server._cleanup = () => {
    rateLimiter.stop();
    return logger.close();
  };

  return server;
}

export function loadInternalConfig() {
  loadDotEnv();
  const bridgeToken = optionalEnv("BRIDGE_TOKEN", "");
  const defaultModel = optionalEnv("DEFAULT_MODEL", "gpt-5.5");
  return {
    upstreamBaseURL: normalizeBaseURL(requiredEnv("UPSTREAM_BASE_URL"), "UPSTREAM_BASE_URL"),
    upstreamAPIKey: requiredEnv("UPSTREAM_API_KEY"),
    bridgeToken,
    listenAddr: optionalEnv("INTERNAL_LISTEN_ADDR", "127.0.0.1:18787"),
    defaultModel,
    models: parseModelsEnv([defaultModel]),
    modelMap: parseModelMapEnv(),
    requestBodyLimitBytes: parseIntegerEnv("REQUEST_BODY_LIMIT_BYTES", 25 * 1024 * 1024),
    upstreamTimeoutMs: parseIntegerEnv("UPSTREAM_TIMEOUT_MS", 120_000),
    rateLimitRpm: parseIntegerEnv("RATE_LIMIT_RPM", 60),
    logLevel: optionalEnv("LOG_LEVEL", "info"),
    logFile: optionalEnv("LOG_FILE", "")
  };
}

export function startInternalBridge(config = loadInternalConfig()) {
  const logger = config.logger || createLogger({
    service: "internal-bridge",
    level: config.logLevel,
    logFile: config.logFile
  });
  config.logger = logger;

  validateBridgeToken(config.bridgeToken, { logger });

  const server = createInternalBridgeServer(config);
  const { host, port } = parseListenAddr(config.listenAddr);

  server.once("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`[internal-bridge] failed to listen on ${host}:${port}: address already in use. Change INTERNAL_LISTEN_ADDR or stop the process using this port.`);
      process.exitCode = 1;
      return;
    }
    console.error(`[internal-bridge] server error: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    logger.info("server_listening", {
      listen_url: `http://${host}:${port}`,
      default_model: config.defaultModel,
      models: config.models,
      model_map: config.modelMap,
      log_file: config.logFile || ""
    });
  });

  setupGracefulShutdown(server, "internal-bridge");
  return server;
}

/**
 * 构造请求体重写器：把请求体里的 model 别名替换成公司真实模型 ID。
 * 仅对 /responses 和 /chat/completions 生效；非 JSON 或未命中别名则原样透传。
 */
function createModelRewriter(modelMap) {
  return (req, body) => {
    if (!body || !modelMap || Object.keys(modelMap).length === 0) {
      return body;
    }
    try {
      const url = new URL(req.url, "http://local");
      const pathname = url.pathname;
      const isResponses =
        pathname === "/responses" ||
        pathname === "/openai/responses" ||
        pathname === "/v1/responses";
      const isChat =
        pathname === "/chat/completions" ||
        pathname === "/openai/chat/completions" ||
        pathname === "/v1/chat/completions";
      if (!isResponses && !isChat) {
        return body;
      }
      const payload = JSON.parse(body.toString("utf8"));
      if (
        payload &&
        typeof payload === "object" &&
        typeof payload.model === "string" &&
        modelMap[payload.model]
      ) {
        payload.model = modelMap[payload.model];
        return Buffer.from(JSON.stringify(payload), "utf8");
      }
    } catch {
      // 不是 JSON 或解析失败，原样透传
    }
    return body;
  };
}

function isModelsPath(pathname) {
  return pathname === "/models" ||
    pathname === "/v1/models" ||
    pathname === "/openai/models";
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

    // Give in-flight requests a short grace period, then exit.
    setTimeout(() => {
      process.exit(0);
    }, 5000).unref?.();
  }

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  try {
    startInternalBridge();
  } catch (error) {
    console.error(`[internal-bridge] failed to start: ${error.message}`);
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
