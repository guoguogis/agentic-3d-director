import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { describeAiConfig, parseEnvContent, resolveAiConfig } from "./aiConfig.mjs";
import { AiApiError, parseDecisionText, requestDirectorDecision } from "./aiProvider.mjs";

async function withJsonServer(handler, run) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    requests.push({ headers: request.headers, body });
    const { status = 200, payload } = await handler({ request, body, index: requests.length - 1 });
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  try {
    return await run({ baseUrl: `http://127.0.0.1:${port}/v1`, requests });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function apiConfig(overrides = {}) {
  return {
    mode: "api",
    requestedMode: "api",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "test-model",
    apiKey: "sk-test-secret-1234",
    jsonMode: "auto",
    temperature: undefined,
    maxTokens: 256,
    timeoutMs: 5000,
    ...overrides,
  };
}

const PROMPT = { system: "系统提示", user: "当前工程状态" };
const DECISION = {
  message: "已新增角色",
  commands: [
    { name: "director_add_character", arguments_json: '{"name":"甲"}' },
    { name: "director_validate", arguments_json: "{}" },
  ],
};

test("calls an OpenAI-compatible endpoint with json_schema and parses the decision", async () => {
  await withJsonServer(
    () => ({ payload: { choices: [{ message: { content: JSON.stringify(DECISION) } }] } }),
    async ({ baseUrl, requests }) => {
      const result = await requestDirectorDecision({ config: apiConfig({ baseUrl }), prompt: PROMPT });

      assert.equal(result.message, "已新增角色");
      assert.equal(result.commands.length, 2);
      assert.deepEqual(result.commands[0], { name: "director_add_character", arguments: { name: "甲" } });

      assert.equal(requests.length, 1);
      assert.equal(requests[0].headers.authorization, "Bearer sk-test-secret-1234");
      assert.equal(requests[0].body.model, "test-model");
      assert.equal(requests[0].body.response_format.type, "json_schema");
      assert.deepEqual(
        requests[0].body.messages.map((message) => message.role),
        ["system", "user"],
      );
    },
  );
});

test("degrades from json_schema to json_object when the provider rejects the schema", async () => {
  await withJsonServer(
    ({ index }) => (index === 0
      ? { status: 400, payload: { error: { message: "response_format json_schema is not supported" } } }
      : { payload: { choices: [{ message: { content: JSON.stringify(DECISION) } }] } }),
    async ({ baseUrl, requests }) => {
      const result = await requestDirectorDecision({ config: apiConfig({ baseUrl }), prompt: PROMPT });

      assert.equal(result.message, "已新增角色");
      assert.equal(requests.length, 2);
      assert.equal(requests[0].body.response_format.type, "json_schema");
      assert.equal(requests[1].body.response_format.type, "json_object");
    },
  );
});

test("reports auth failures without leaking the api key or retrying", async () => {
  await withJsonServer(
    () => ({ status: 401, payload: { error: { message: "invalid api key" } } }),
    async ({ baseUrl, requests }) => {
      await assert.rejects(
        () => requestDirectorDecision({ config: apiConfig({ baseUrl }), prompt: PROMPT }),
        (error) => {
          assert.ok(error instanceof AiApiError);
          assert.equal(error.status, 401);
          assert.match(error.message, /认证失败/);
          assert.doesNotMatch(error.message, /sk-test-secret-1234/);
          return true;
        },
      );
      assert.equal(requests.length, 1);
    },
  );
});

test("parses decisions wrapped in markdown fences or extra prose", () => {
  const fenced = `这是结果：\n\`\`\`json\n${JSON.stringify(DECISION)}\n\`\`\``;
  assert.equal(parseDecisionText(fenced).commands.length, 2);

  const prose = `我先读取工程。{"message":"已完成","commands":[]} 以上。`;
  assert.equal(parseDecisionText(prose).message, "已完成");
});

test("rejects responses that contain no usable json", () => {
  assert.throws(() => parseDecisionText("抱歉，我无法完成。"), /不是有效的导演指令 JSON/);
});

test("accepts slightly off-schema decisions from weaker models", () => {
  const lenient = parseDecisionText(JSON.stringify({
    reply: "我先把角色加到画面左侧。",
    commands: [{ name: "director_add_character", arguments: { name: "甲" } }],
  }));
  assert.equal(lenient.message, "我先把角色加到画面左侧。");
  assert.deepEqual(lenient.commands, [{ name: "director_add_character", arguments: { name: "甲" } }]);

  const stringCommands = parseDecisionText(JSON.stringify({
    message: "ok",
    commands: '[{"name":"director_validate","arguments_json":"{}"}]',
  }));
  assert.deepEqual(stringCommands.commands, [{ name: "director_validate", arguments: {} }]);
});

test("retries once with a repair hint when the model returns invalid JSON", async () => {
  await withJsonServer(
    ({ index }) => (index === 0
      ? { payload: { choices: [{ message: { content: '{"message":"我做不到' } }] } }
      : { payload: { choices: [{ message: { content: JSON.stringify(DECISION) } }] } }),
    async ({ baseUrl, requests }) => {
      const result = await requestDirectorDecision({
        config: apiConfig({ baseUrl, jsonMode: "json_object" }),
        prompt: PROMPT,
      });

      assert.equal(result.message, "已新增角色");
      assert.equal(requests.length, 2);
      assert.equal(requests[1].body.messages.length, 3);
      assert.match(requests[1].body.messages[2].content, /只输出一个 JSON 对象/);
    },
  );
});

test("resolves config from .env-style keys with auto mode falling back to codex", () => {
  const api = resolveAiConfig({ AI_API_KEY: "sk-abc", AI_MODEL: "deepseek-chat", AI_BASE_URL: "https://api.deepseek.com/v1/" });
  assert.equal(api.mode, "api");
  assert.equal(api.model, "deepseek-chat");
  assert.equal(api.baseUrl, "https://api.deepseek.com/v1");

  const codex = resolveAiConfig({});
  assert.equal(codex.mode, "codex");
  assert.equal(codex.apiKey, undefined);
  assert.equal(codex.jsonMode, "auto");

  assert.throws(() => resolveAiConfig({ AI_MODE: "api" }), /AI_API_KEY/);
  assert.throws(() => resolveAiConfig({ AI_MODE: "unknown" }), /AI_MODE/);
  assert.throws(() => resolveAiConfig({ AI_API_KEY: "k", AI_JSON_MODE: "yaml" }), /AI_JSON_MODE/);
});

test("parses .env content and never exposes the raw key in the status summary", () => {
  const parsed = parseEnvContent([
    "# 注释",
    "export AI_MODE=api",
    'AI_API_KEY="sk-test-secret-1234"',
    "AI_MODEL='deepseek-chat'",
    "EMPTY=",
  ].join("\n"));
  assert.deepEqual(parsed, {
    AI_MODE: "api",
    AI_API_KEY: "sk-test-secret-1234",
    AI_MODEL: "deepseek-chat",
    EMPTY: "",
  });

  const summary = describeAiConfig(apiConfig());
  assert.equal(summary.mode, "api");
  assert.equal(summary.apiKeyHint, "sk-***1234");
  assert.doesNotMatch(JSON.stringify(summary), /sk-test-secret-1234/);

  const codexSummary = describeAiConfig(resolveAiConfig({}));
  assert.equal(codexSummary.mode, "codex");
  assert.equal(codexSummary.note.includes("Codex CLI"), true);
});
