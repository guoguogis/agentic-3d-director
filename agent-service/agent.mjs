import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAiConfig } from "./aiConfig.mjs";
import { requestDirectorDecision } from "./aiProvider.mjs";
import { buildDecisionSchema, buildDirectorPrompt, safeDecision } from "./decision.mjs";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findCodex() {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }

  return "codex";
}

function run(command, args, input, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("导演助手响应超时"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8");
      const errors = Buffer.concat(stderr).toString("utf8");
      if (code === 0) resolve({ stdout: output, stderr: errors });
      else reject(new Error(errors.trim() || output.trim() || `Codex exited with ${code}`));
    });
    child.stdin.end(input);
  });
}

/** 回落到本机 Codex CLI：一次性、read-only、schema 约束，无工具权限。 */
async function runCodexDecision(prompt) {
  const codex = await findCodex();
  const root = await mkdtemp(join(tmpdir(), "storyai-director-agent-"));
  const schemaPath = join(root, "response.schema.json");
  const outputPath = join(root, "response.json");

  await writeFile(schemaPath, JSON.stringify(buildDecisionSchema()), "utf8");
  try {
    await run(
      codex,
      [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "-s",
        "read-only",
        "-c",
        'approval_policy="never"',
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "-",
      ],
      prompt.combined,
    );
    return JSON.parse(await readFile(outputPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "未找到 codex CLI。可以在项目根目录 .env 里配置 AI_API_KEY 直接调用 AI 接口，或用 CODEX_CLI_PATH 指定 Codex 可执行文件。",
      );
    }
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runDirectorAgent({ messages, getState, execute }) {
  let state = getState();
  if (!state) throw new Error("导演台尚未连接，请打开网页并等待“已连接当前导演工程”");

  const prompt = buildDirectorPrompt({ state, messages });
  const config = resolveAiConfig();
  const decision = config.mode === "api"
    ? await requestDirectorDecision({ config, prompt })
    : safeDecision(await runCodexDecision(prompt));

  const commandResults = [];
  for (const command of decision.commands) {
    try {
      const argumentsValue = {
        ...command.arguments,
        ...(command.name === "director_validate" ? {} : { expected_revision: state.revision }),
      };
      state = await execute(command.name, argumentsValue);
      commandResults.push({ name: command.name, ok: true });
    } catch (error) {
      commandResults.push({
        name: command.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }

  return {
    message: decision.message,
    commands: commandResults,
    // 只有「看图产出建模提示词」这类请求才有值
    modelingPrompt: decision.modelingPrompt || "",
    state,
  };
}
