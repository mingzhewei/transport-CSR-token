import fs from "node:fs";
import path from "node:path";

export function loadDotEnv(filePath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equals = line.indexOf("=");
    if (equals < 0) {
      continue;
    }

    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function optionalEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

export function parseListenAddr(value) {
  const input = value || "127.0.0.1:0";
  const index = input.lastIndexOf(":");
  if (index < 0) {
    return { host: input, port: 0 };
  }

  const host = input.slice(0, index) || "0.0.0.0";
  const portText = input.slice(index + 1);
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid listen address port: ${value}`);
  }
  return { host, port };
}

export function normalizeBaseURL(value, name) {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid ${name}: ${value}`);
  }
}

export function parseIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${name}: ${raw} (must be a non-negative integer)`);
  }
  return value;
}

export function validateBridgeToken(token, { logger } = {}) {
  if (!token) {
    if (logger) {
      logger.warn("bridge_token_empty", {
        message: "BRIDGE_TOKEN is empty. external-client can connect to internal-bridge without authentication. Only safe on a trusted single-user machine."
      });
    }
    return;
  }

  if (token.length < 16) {
    throw new Error(
      "BRIDGE_TOKEN is too short (must be at least 16 characters, 32+ recommended). Generate one with: openssl rand -base64 32"
    );
  }

  // Reject obvious weak / sequential tokens.
  const weakPatterns = [
    /^\d{6,}$/,
    /^password$/i,
    /^12345678/,
    /^abcdefg/i,
    /^bridge-token/i
  ];
  if (weakPatterns.some((pattern) => pattern.test(token))) {
    throw new Error(
      "BRIDGE_TOKEN looks too predictable. Generate a strong random token with: openssl rand -base64 32"
    );
  }
}

export function parseModelsEnv(fallback) {
  const raw = process.env.MODELS;
  if (!raw) {
    return fallback;
  }
  return raw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

/**
 * 解析模型别名映射：客户端用的别名 -> 公司真实模型 ID。
 * 格式：MODEL_MAP=gpt-5.5=company-gpt-5.5-v3,gpt-5=company-gpt-5-v2
 * 公司变更真实模型 ID 时，只需在这里改真实 ID，外部电脑零改动。
 */
export function parseModelMapEnv() {
  const raw = process.env.MODEL_MAP;
  if (!raw) {
    return {};
  }
  const map = {};
  for (const pair of raw.split(",")) {
    const entry = pair.trim();
    if (!entry) {
      continue;
    }
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const alias = entry.slice(0, eq).trim();
    const real = entry.slice(eq + 1).trim();
    if (alias && real) {
      map[alias] = real;
    }
  }
  return map;
}
