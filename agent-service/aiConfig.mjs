import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serviceDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(serviceDirectory);

export const DEFAULT_ENV_PATH = join(projectRoot, ".env");

export const AI_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  timeoutMs: 120_000,
  maxTokens: 4096,
};

const VALID_MODES = new Set(["auto", "api", "codex"]);
const VALID_JSON_MODES = new Set(["auto", "json_schema", "json_object", "none"]);

let envLoaded = false;

/** 极简 .env 解析：KEY=VALUE、# 注释、可选 export 前缀、成对引号。 */
export function parseEnvContent(content) {
  const result = {};
  for (const line of String(content).replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    let key = trimmed.slice(0, separator).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    if (!key) continue;
    let value = trimmed.slice(separator + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
}

/**
 * 读取项目根目录 .env，不覆盖进程里已存在的环境变量。
 * 返回统计信息，便于启动时打印“配置文件是否生效”。
 */
export function loadProjectEnv({
  envPath = DEFAULT_ENV_PATH,
  env = process.env,
  readFile = (path) => readFileSync(path, "utf8"),
} = {}) {
  let content;
  try {
    content = readFile(envPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { loaded: false, path: envPath, applied: 0, skipped: 0 };
    throw error;
  }
  const parsed = parseEnvContent(content);
  let applied = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value;
      applied += 1;
    }
  }
  return { loaded: true, path: envPath, applied, skipped: Object.keys(parsed).length - applied };
}

function firstDefined(env, names) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function optionalPositiveNumber(value, label) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} 必须是正数，当前为 ${value}`);
  return parsed;
}

export function maskApiKey(apiKey) {
  if (!apiKey) return null;
  if (apiKey.length <= 8) return "***";
  return `${apiKey.slice(0, 3)}***${apiKey.slice(-4)}`;
}

/**
 * 解析当前生效的 AI 配置。
 * mode=auto：有 key 直接调 API，否则回落到本机 codex CLI。
 */
export function resolveAiConfig(env = process.env) {
  if (!envLoaded) {
    envLoaded = true;
    loadProjectEnv({ env });
  }

  const apiKey = firstDefined(env, ["AI_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"]);
  const baseUrl = (firstDefined(env, ["AI_BASE_URL", "OPENAI_BASE_URL"]) ?? AI_DEFAULTS.baseUrl).replace(/\/+$/, "");
  const model = firstDefined(env, ["AI_MODEL", "OPENAI_MODEL"]) ?? AI_DEFAULTS.model;

  const requestedMode = (firstDefined(env, ["AI_MODE"]) ?? "auto").toLowerCase();
  if (!VALID_MODES.has(requestedMode)) {
    throw new Error(`AI_MODE=${requestedMode} 无效，可选 auto | api | codex`);
  }
  const mode = requestedMode === "auto" ? (apiKey ? "api" : "codex") : requestedMode;
  if (mode === "api" && !apiKey) {
    throw new Error("AI_MODE=api 但没有配置 AI_API_KEY：请在项目根目录 .env 中填写，或把 AI_MODE 改回 auto/codex");
  }

  const jsonMode = (firstDefined(env, ["AI_JSON_MODE"]) ?? "auto").toLowerCase();
  if (!VALID_JSON_MODES.has(jsonMode)) {
    throw new Error(`AI_JSON_MODE=${jsonMode} 无效，可选 auto | json_schema | json_object | none`);
  }

  const temperature = optionalPositiveNumber(firstDefined(env, ["AI_TEMPERATURE"]), "AI_TEMPERATURE");
  if (temperature !== undefined && temperature > 2) {
    throw new Error(`AI_TEMPERATURE=${temperature} 超出范围，应在 0 到 2 之间`);
  }

  return {
    mode,
    requestedMode,
    baseUrl,
    model,
    apiKey,
    jsonMode,
    temperature,
    maxTokens: optionalPositiveNumber(firstDefined(env, ["AI_MAX_TOKENS"]), "AI_MAX_TOKENS") ?? AI_DEFAULTS.maxTokens,
    timeoutMs: optionalPositiveNumber(firstDefined(env, ["AI_TIMEOUT_MS"]), "AI_TIMEOUT_MS") ?? AI_DEFAULTS.timeoutMs,
  };
}

/** 给网页/日志看的配置摘要，永远不包含明文 key。 */
export function describeAiConfig(config = resolveAiConfig()) {
  const usingApi = config.mode === "api";
  return {
    mode: config.mode,
    requestedMode: config.requestedMode,
    provider: usingApi ? "openai-compatible" : "codex-cli",
    baseUrl: usingApi ? config.baseUrl : null,
    model: usingApi ? config.model : null,
    jsonMode: usingApi ? config.jsonMode : null,
    apiKeyHint: usingApi ? maskApiKey(config.apiKey) : null,
    note: usingApi
      ? "导演助手直接调用 OpenAI 兼容接口，密钥只保存在本机 .env，不进入浏览器。"
      : "未检测到 AI_API_KEY，当前回落到本机 Codex CLI。",
  };
}
