import crypto from "node:crypto";
import http from "node:http";
import { Readable, Transform } from "node:stream";
import { createLogger } from "./logger.mjs";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const REQUEST_SKIP_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "host",
  "content-length"
]);

const RESPONSE_SKIP_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "content-length",
  "content-encoding"
]);

const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;

export function sendJSON(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

export function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}

export function getBearerToken(req) {
  const value = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1] : "";
}

export function safeEqual(a, b) {
  if (!a || !b) {
    return false;
  }
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export function requireBearer(req, expectedToken) {
  if (!expectedToken) {
    return true;
  }
  return safeEqual(getBearerToken(req), expectedToken);
}

export function buildTargetURL(baseURL, requestURL) {
  const base = new URL(baseURL);
  const incoming = new URL(requestURL, "http://local");
  let suffix = incoming.pathname;

  for (const prefix of ["/openai", "/v1"]) {
    if (suffix === prefix) {
      suffix = "/";
      break;
    }
    if (suffix.startsWith(`${prefix}/`)) {
      suffix = suffix.slice(prefix.length);
      break;
    }
  }

  const basePath = base.pathname.replace(/\/+$/, "");
  const suffixPath = suffix.startsWith("/") ? suffix : `/${suffix}`;
  base.pathname = `${basePath}${suffixPath}`.replace(/\/{2,}/g, "/");
  base.search = incoming.search;
  return base;
}

export async function readRequestBody(req, limitBytes = 25 * 1024 * 1024) {
  if (req.method === "GET" || req.method === "HEAD") {
    return undefined;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      const error = new Error(`Request body exceeds ${limitBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function copyRequestHeaders(sourceHeaders, extraHeaders = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(sourceHeaders)) {
    const lower = name.toLowerCase();
    if (REQUEST_SKIP_HEADERS.has(lower) || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      headers.set(name, value.join(", "));
    } else {
      headers.set(name, value);
    }
  }

  for (const [name, value] of Object.entries(extraHeaders)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    headers.set(name, value);
  }
  return headers;
}

export function copyResponseHeaders(upstreamResponse) {
  const headers = {};
  for (const [name, value] of upstreamResponse.headers.entries()) {
    if (RESPONSE_SKIP_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    headers[name] = value;
  }
  return headers;
}

export function handleCORS(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "authorization, content-type, x-request-id"
  );
  res.setHeader("access-control-max-age", "86400");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

export async function proxyRequest(req, res, options) {
  const {
    targetBaseURL,
    authorizationToken,
    requestBodyLimitBytes,
    upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
    logPrefix = "proxy",
    logger = createLogger({ service: logPrefix })
  } = options;

  const target = buildTargetURL(targetBaseURL, req.url);
  const rawBody = await readRequestBody(req, requestBodyLimitBytes);
  const body = options.rewriteBody ? options.rewriteBody(req, rawBody) : rawBody;
  const headers = copyRequestHeaders(req.headers, {
    "x-request-id": req.requestId,
    authorization: authorizationToken ? `Bearer ${authorizationToken}` : undefined
  });

  const startedAt = Date.now();
  const { abortController, clearTimeout: clearAbortTimeout, dispose: disposeAbort } =
    createRequestAbortController(req, res, upstreamTimeoutMs);

  let upstreamResponse;
  logger.info("upstream_request_start", {
    request_id: req.requestId,
    method: req.method,
    path: new URL(req.url, "http://local").pathname,
    target: redactURL(target),
    request_bytes: body?.length || 0,
    body_rewritten: body !== rawBody
  });

  try {
    upstreamResponse = await fetch(target, {
      method: req.method,
      headers,
      body,
      signal: abortController.signal
    });
  } catch (error) {
    disposeAbort();
    const isAbort = error.name === "AbortError" || abortController.signal.aborted;
    logger.error("upstream_request_error", {
      request_id: req.requestId,
      method: req.method,
      target: redactURL(target),
      aborted: isAbort,
      error: error.message
    });
    if (!res.headersSent) {
      const status = isAbort ? 504 : 502;
      const errorPayload = {
        error: {
          message: isAbort
            ? "Upstream request timed out or was cancelled"
            : "Upstream request failed",
          type: isAbort ? "upstream_timeout" : "upstream_error"
        }
      };
      if (options.onErrorHint) {
        try {
          const hint = options.onErrorHint({ isAbort, status, target: redactURL(target) });
          if (hint) {
            errorPayload.error.hint = hint;
          }
        } catch {
          // hint is best-effort
        }
      }
      if (options.onError) {
        try {
          options.onError({ isAbort, status, request_id: req.requestId, error: error.message });
        } catch {
          // ignore
        }
      }
      sendJSON(res, status, errorPayload);
    }
    return;
  }

  // Headers received: cancel the timeout, but keep listening for client disconnect
  // during streaming so we can abort the upstream body reader.
  clearAbortTimeout();

  const responseHeaders = copyResponseHeaders(upstreamResponse);
  res.writeHead(upstreamResponse.status, responseHeaders);

  logger.info("upstream_response_headers", {
    request_id: req.requestId,
    method: req.method,
    path: new URL(req.url, "http://local").pathname,
    status: upstreamResponse.status,
    content_type: upstreamResponse.headers.get("content-type") || "",
    duration_ms: Date.now() - startedAt
  });

  if (!upstreamResponse.body) {
    disposeAbort();
    res.end();
    return;
  }

  let chunkCount = 0;
  let responseBytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      chunkCount += 1;
      responseBytes += chunk.length;
      callback(null, chunk);
    },
    flush(callback) {
      logger.info("upstream_response_stream_end", {
        request_id: req.requestId,
        status: upstreamResponse.status,
        chunk_count: chunkCount,
        response_bytes: responseBytes,
        duration_ms: Date.now() - startedAt
      });
      callback();
    }
  });

  function onStreamError(error, source) {
    logger.error("upstream_stream_error", {
      request_id: req.requestId,
      source,
      error: error.message
    });
    try {
      abortController.abort();
    } catch {
      // ignore
    }
    try {
      if (!res.writableEnded) {
        res.destroy(error);
      }
    } catch {
      // ignore
    }
    disposeAbort();
  }

  const upstreamStream = Readable.fromWeb(upstreamResponse.body);
  upstreamStream.on("error", (error) => onStreamError(error, "upstream"));
  counter.on("error", (error) => onStreamError(error, "counter"));
  res.on("error", (error) => onStreamError(error, "response"));

  res.once("finish", () => {
    disposeAbort();
  });
  res.once("close", () => {
    disposeAbort();
  });

  upstreamStream.pipe(counter).pipe(res);
}

export function createServer(handler, options = {}) {
  const logger = options.logger || createLogger({ service: options.service || "server" });
  return http.createServer((req, res) => {
    req.requestId = headerValue(req.headers["x-request-id"]) || crypto.randomUUID();
    const startedAt = Date.now();
    const requestURL = new URL(req.url, "http://local");

    logger.info("request_start", {
      request_id: req.requestId,
      method: req.method,
      path: requestURL.pathname,
      query: requestURL.search || "",
      remote_addr: req.socket.remoteAddress,
      user_agent: req.headers["user-agent"] || ""
    });

    res.setHeader("x-request-id", req.requestId);
    res.once("finish", () => {
      logger.info("request_finish", {
        request_id: req.requestId,
        method: req.method,
        path: requestURL.pathname,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt
      });
    });
    res.once("close", () => {
      if (!res.writableEnded) {
        logger.warn("request_closed_before_finish", {
          request_id: req.requestId,
          method: req.method,
          path: requestURL.pathname,
          status: res.statusCode,
          duration_ms: Date.now() - startedAt
        });
      }
    });

    Promise.resolve(handler(req, res)).catch((error) => {
      logger.error("request_error", {
        request_id: req.requestId,
        path: req.url,
        error: error.message
      });
      if (!res.headersSent) {
        sendJSON(res, error.statusCode || 500, {
          error: {
            message: error.statusCode ? error.message : "Internal server error",
            type: "server_error"
          }
        });
      } else {
        res.destroy(error);
      }
    });
  });
}

function createRequestAbortController(req, res, timeoutMs) {
  const abortController = new AbortController();
  let timeoutId;

  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      abortController.abort(
        new Error(`Upstream request timed out after ${timeoutMs}ms`)
      );
    }, timeoutMs);
  }

  function onClientClose() {
    if (!req.complete || !res.writableEnded) {
      abortController.abort(new Error("Client closed connection"));
    }
  }

  req.once("close", onClientClose);
  res.once("close", onClientClose);

  function clearTimeoutFn() {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  }

  return {
    abortController,
    clearTimeout: clearTimeoutFn,
    dispose() {
      clearTimeoutFn();
      req.off("close", onClientClose);
      res.off("close", onClientClose);
    }
  };
}

function redactURL(url) {
  const clone = new URL(url);
  clone.username = "";
  clone.password = "";
  return clone.toString();
}

function headerValue(value) {
  if (Array.isArray(value)) {
    return value[0] || "";
  }
  return value || "";
}
