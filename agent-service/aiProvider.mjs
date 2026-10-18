import { buildDecisionSchema, safeDecision } from "./decision.mjs";

export class AiApiError extends Error {
  constructor(message, { status, code, retryableFormat = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "AiApiError";
    this.status = status;
    this.code = code;
    this.retryableFormat = retryableFormat;
  }
}

function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function redact(text, apiKey) {
  if (!text) return "";
  const withoutKey = apiKey && apiKey.length > 3 ? text.split(apiKey).join("***") : text;
  return withoutKey.length > 400 ? `${withoutKey.slice(0, 400)}…` : withoutKey;
}

function describeHttpError(status, body, config) {
  const snippet = redact(body, config.apiKey);
  const suffix = snippet ? `\n服务返回：${snippet}` : "";
  if (status === 401 || status === 403) {
    return new AiApiError(`AI 接口认证失败（HTTP ${status}）。请检查 .env 里的 AI_API_KEY 是否正确、是否过期。${suffix}`, {
      status,
    });
  }
  if (status === 404) {
    return new AiApiError(
      `AI 接口地址不存在（HTTP 404）。请检查 .env 里的 AI_BASE_URL，通常需要以 /v1 结尾，例如 https://api.openai.com/v1。${suffix}`,
      { status },
    );
  }
  if (status === 429) {
    return new AiApiError(`AI 接口限流或额度不足（HTTP 429），请稍后重试或检查账户余额。${suffix}`, { status });
  }
  if (status >= 500) {
    return new AiApiError(`AI 服务端错误（HTTP ${status}），通常是上游临时故障，请稍后重试。${suffix}`, { status });
  }
  return new AiApiError(`AI 接口返回 HTTP ${status}。${suffix}`, {
    status,
    retryableFormat: status === 400 || status === 422,
  });
}

function buildResponseFormat(mode, schema) {
  if (mode === "json_schema") {
    return { type: "json_schema", json_schema: { name: "director_plan", strict: true, schema } };
  }
  if (mode === "json_object") return { type: "json_object" };
  return undefined;
}

function extractContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  if (typeof payload?.output_text === "string") return payload.output_text;
  return "";
}

/** 从可能带 ```json 围栏或解释性文字的回复里找出 JSON 对象。 */
export function extractJsonObject(text) {
  const source = String(text ?? "");
  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

export function parseDecisionText(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    throw new AiApiError("AI 接口返回了空内容，请稍后重试。", { code: "AI_INVALID_JSON" });
  }

  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const balanced = extractJsonObject(trimmed);
  if (balanced) candidates.push(balanced);

  let lastError;
  for (const candidate of candidates) {
    try {
      return safeDecision(JSON.parse(candidate));
    } catch (error) {
      lastError = error;
    }
  }
  const needsArrayCommands = /"commands"\s*:\s*\[/.test(trimmed);
  throw new AiApiError(
    `AI 返回的内容不是有效的导演指令 JSON${needsArrayCommands ? "（JSON 可能被截断）" : ""}：${redact(trimmed, "")}`,
    { code: "AI_INVALID_JSON", cause: lastError },
  );
}

async function requestOnce({ config, messages, mode, fetchImpl, signal }) {
  const body = { model: config.model, messages, stream: false };
  if (config.temperature !== undefined) body.temperature = config.temperature;
  if (config.maxTokens) body.max_tokens = config.maxTokens;
  const responseFormat = buildResponseFormat(mode, buildDecisionSchema());
  if (responseFormat) body.response_format = responseFormat;

  const timeout = AbortSignal.timeout(config.timeoutMs);
  let response;
  try {
    response = await fetchImpl(joinUrl(config.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(config.apiKey) },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new AiApiError(`AI 接口在 ${Math.round(config.timeoutMs / 1000)} 秒内没有响应，请检查网络或调大 AI_TIMEOUT_MS。`, {
        cause: error,
      });
    }
    throw new AiApiError(`无法连接 AI 接口 ${config.baseUrl}：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  const raw = await response.text();
  if (!response.ok) throw describeHttpError(response.status, raw, config);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new AiApiError(`AI 接口返回的不是 JSON：${redact(raw, config.apiKey)}`, { cause: error });
  }
  return extractContent(payload);
}

const FORMAT_REPAIR_HINT =
  "上一次输出不是合法的导演指令 JSON。请重新输出，并且只输出一个 JSON 对象：" +
  '{"message":"给用户的回复","commands":[]}。' +
  "不要 Markdown 代码块，不要解释文字，确保所有字符串闭合、JSON 完整，键名必须严格是 message 和 commands。";

/**
 * 调用 OpenAI 兼容的 /chat/completions，返回经过白名单过滤的导演决策。
 * jsonMode=auto 时按 json_schema → json_object → 纯文本 依次降级，兼容不完整的实现。
 */
export async function requestDirectorDecision({ config, prompt, fetchImpl = fetch, signal }) {
  if (!config.apiKey) {
    throw new AiApiError("缺少 AI_API_KEY，无法调用 AI 接口。请在项目根目录 .env 中配置。");
  }
  const messages = [
    { role: "system", content: prompt.system },
    // 带图时用 parts 数组（文本 + image_url）；纯文本保持字符串，行为不变
    { role: "user", content: prompt.userContent ?? prompt.user },
  ];
  const modes = config.jsonMode === "auto" ? ["json_schema", "json_object", "none"] : [config.jsonMode];

  let lastError;
  for (const mode of modes) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const attemptMessages = attempt === 0 ? messages : [...messages, { role: "user", content: FORMAT_REPAIR_HINT }];
      try {
        const text = await requestOnce({ config, messages: attemptMessages, mode, fetchImpl, signal });
        return parseDecisionText(text);
      } catch (error) {
        lastError = error;
        const unsupportedFormat = error instanceof AiApiError && (error.status === 400 || error.status === 422);
        if (unsupportedFormat) break;
        const invalidJson = error instanceof AiApiError && error.code === "AI_INVALID_JSON";
        if (invalidJson && attempt === 0) continue;
        if (!invalidJson) throw error;
      }
    }
  }

  const hint = lastError instanceof AiApiError && config.jsonMode === "auto"
    ? "\n提示：该接口可能既不支持 json_schema，json_object 输出也不稳定；可在 .env 里设 AI_JSON_MODE=none 或换用更强的模型。"
    : "";
  throw new AiApiError(`${lastError?.message ?? "AI 调用失败"}${hint}`, {
    status: lastError?.status,
    code: lastError?.code ?? "AI_FAILED",
    cause: lastError,
  });
}
