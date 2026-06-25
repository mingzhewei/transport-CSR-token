import fs from "node:fs";
import path from "node:path";

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export function createLogger(options = {}) {
  const service = options.service || "model-bridge";
  const levelName = (options.level || process.env.LOG_LEVEL || "info").toLowerCase();
  const threshold = LEVELS[levelName] ?? LEVELS.info;
  const logFile = options.logFile || process.env.LOG_FILE || "";

  let stream;
  if (logFile) {
    fs.mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true });
    stream = fs.createWriteStream(logFile, { flags: "a", autoClose: false });
  }

  function write(level, event, fields = {}) {
    if ((LEVELS[level] ?? LEVELS.info) < threshold) {
      return;
    }

    let line;
    try {
      line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        service,
        event,
        pid: process.pid,
        ...sanitize(fields)
      });
    } catch (error) {
      line = JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        service,
        event: "log_serialization_failed",
        pid: process.pid,
        error: error.message
      });
    }

    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }

    if (stream) {
      stream.write(`${line}\n`);
    }
  }

  function close() {
    if (stream) {
      return new Promise((resolve) => stream.end(resolve));
    }
    return Promise.resolve();
  }

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    close
  };
}

function sanitize(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, seen));
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);
    const output = {};
    for (const [key, fieldValue] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        output[key] = "[redacted]";
      } else {
        output[key] = sanitize(fieldValue, seen);
      }
    }
    seen.delete(value);
    return output;
  }

  return value;
}

function isSensitiveKey(key) {
  return /authorization|api[_-]?key|token|secret|password|credential/i.test(key);
}
