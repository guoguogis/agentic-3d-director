import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { createDirectorAgentHttpServer } from "./httpServer.mjs";

const DECISION = {
  message: "已新增角色乙",
  commands: [{ name: "director_add_character", arguments_json: '{"name":"乙"}' }],
};

let llmRequests = [];
let llmServer;
let agentServer;
let agentBaseUrl;

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")));
  });
}

before(async () => {
  llmServer = createServer(async (request, response) => {
    const body = await readBody(request);
    llmRequests.push({ headers: request.headers, body });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(DECISION) } }] }));
  });
  await new Promise((resolve, reject) => {
    llmServer.once("error", reject);
    llmServer.listen(0, "127.0.0.1", resolve);
  });

  process.env.AI_MODE = "api";
  process.env.AI_API_KEY = "sk-e2e-123456";
  process.env.AI_MODEL = "e2e-model";
  process.env.AI_BASE_URL = `http://127.0.0.1:${llmServer.address().port}/v1`;
  process.env.AI_JSON_MODE = "json_object";
  process.env.AI_TIMEOUT_MS = "8000";

  agentServer = createDirectorAgentHttpServer().server;
  await new Promise((resolve, reject) => {
    agentServer.once("error", reject);
    agentServer.listen(0, "127.0.0.1", resolve);
  });
  agentBaseUrl = `http://127.0.0.1:${agentServer.address().port}`;
});

after(async () => {
  for (const key of ["AI_MODE", "AI_API_KEY", "AI_MODEL", "AI_BASE_URL", "AI_JSON_MODE", "AI_TIMEOUT_MS"]) {
    delete process.env[key];
  }
  await new Promise((resolve) => agentServer.close(resolve));
  await new Promise((resolve) => llmServer.close(resolve));
});

async function json(path, init) {
  const response = await fetch(`${agentBaseUrl}${path}`, {
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  return { response, body: await response.json() };
}

test("web assistant calls the configured AI API directly and executes its commands in the browser", async () => {
  const clientId = "browser-e2e";
  const connected = await json("/api/director-agent/connect", {
    method: "POST",
    body: JSON.stringify({
      clientId,
      snapshot: { revision: "p-e2e-1", project: { objects: [] } },
      client: { url: "http://localhost:5173/", visibilityState: "visible", focused: true },
    }),
  });
  assert.equal(connected.response.status, 200);

  const chatPromise = json("/api/director-agent/chat", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "新增一个叫乙的角色" }] }),
  });

  let command = null;
  for (let attempt = 0; attempt < 50 && !command; attempt += 1) {
    const pending = await json(`/api/director-agent/pending?client_id=${clientId}`);
    command = pending.body.command;
    if (!command) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(command?.name, "director_add_character");
  assert.equal(command.arguments.name, "乙");
  assert.equal(command.arguments.expected_revision, "p-e2e-1");

  const nextSnapshot = { revision: "p-e2e-2", project: { objects: [{ id: "char_e2e" }] } };
  await json("/api/director-agent/result", {
    method: "POST",
    body: JSON.stringify({ clientId, commandId: command.id, ok: true, result: nextSnapshot }),
  });

  const chat = await chatPromise;
  assert.equal(chat.response.status, 200);
  assert.equal(chat.body.result.message, "已新增角色乙");
  assert.deepEqual(chat.body.result.commands, [{ name: "director_add_character", ok: true }]);
  assert.equal(chat.body.result.state.revision, "p-e2e-2");

  assert.equal(llmRequests.length, 1);
  assert.equal(llmRequests[0].headers.authorization, "Bearer sk-e2e-123456");
  assert.equal(llmRequests[0].body.model, "e2e-model");
  assert.equal(llmRequests[0].body.response_format.type, "json_object");

  const aiConfig = await json("/api/director-agent/ai-config");
  assert.equal(aiConfig.body.result.mode, "api");
  assert.equal(aiConfig.body.result.provider, "openai-compatible");
  assert.equal(aiConfig.body.result.model, "e2e-model");
  assert.equal(aiConfig.body.result.apiKeyHint, "sk-***3456");
  assert.doesNotMatch(JSON.stringify(aiConfig.body.result), /sk-e2e-123456/);

  const health = await json("/api/director-agent/health");
  assert.deepEqual(health.body.ai, { mode: "api", model: "e2e-model" });
});
