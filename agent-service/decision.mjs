import { BROWSER_COMMAND_NAMES, publicCapabilities } from "./toolDefinitions.mjs";

/** 导演助手必须返回的 JSON 结构，供 codex --output-schema 与 API json_schema 共用。 */
export function buildDecisionSchema(allowedCommands = [...BROWSER_COMMAND_NAMES]) {
  return {
    type: "object",
    additionalProperties: false,
    // 注意：json_schema 的 strict 模式要求**所有**属性都出现在 required 里，
    // 否则模型根本没地方输出这个字段（表现为它嘴上说「已写好」但字段是空的）。
    // 所以这里三个字段全必填，不做建模提示词时给空字符串即可。
    required: ["message", "commands", "modeling_prompt"],
    properties: {
      message: { type: "string" },
      modeling_prompt: {
        type: "string",
        description: "当用户要求把图片或描述转成 3D 建模提示词时，在这里给出完整可复制的提示词；否则留空字符串",
      },
      commands: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "arguments_json"],
          properties: {
            name: { type: "string", enum: allowedCommands },
            arguments_json: { type: "string", description: "A JSON object encoded as a string" },
          },
        },
      },
    },
  };
}

/**
 * 同一条 prompt 拆成 system / user 两段：
 * API 走 messages 数组，codex 用 combined 保持与既有行为完全一致。
 */
/** 取出某条消息里的图片 parts（OpenAI 兼容口径） */
function imagesOf(item) {
  if (!item || !Array.isArray(item.content)) return [];
  return item.content.filter((part) => part && part.type === "image_url" && part?.image_url?.url);
}

/** 取出一条消息的纯文本（图片不能进 transcript 字符串） */
function textOf(item) {
  if (typeof item?.content === "string") return item.content;
  if (!Array.isArray(item?.content)) return "";
  return item.content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
}

export function buildDirectorPrompt({ state, messages }) {
  const conversation = messages
    .slice(-12)
    .map((item) => {
      const imageCount = imagesOf(item).length;
      const suffix = imageCount > 0 ? `（附 ${imageCount} 张图片）` : "";
      return `${item.role === "user" ? "用户" : "导演助手"}：${textOf(item)}${suffix}`;
    })
    .join("\n");

  const system = `你是 StoryAI 3D 导演台内的专业导演助手。你只输出符合 schema 的 JSON。

工作规则：
1. 必须根据当前工程状态里的精确 ID 操作，绝不编造对象。
2. 用户需求明确时输出可执行 commands；含糊或缺少破坏性操作授权时先提一个简洁问题，commands 留空。
3. 位置/缩放使用 {x,y,z} 米制对象，旋转使用 rotation_deg 的角度对象。
4. locked=true 是人工决定，除非用户明确要求覆盖，否则绝不设置 override_locked。
5. 只使用能力清单中已有字段，不操作 DOM，不重置工程，不导出图片。
6. 多步操作按依赖顺序输出；服务会自动为每一步附加最新 expected_revision。
7. 完成多步写操作后追加 director_validate。
8. 回答用简洁中文，说明实际执行或需要澄清的内容。

【看图产出建模提示词】
用户上传图片并要求「转成建模提示词 / 出建模提示词 / 给 3D 生成用的提示词」时：
- 把结果写进顶层 modeling_prompt 字段，commands 留空数组；
- 不是这类请求时，modeling_prompt 必须输出空字符串（字段是必填的，不能省略）；
- message 里只用一两句话概括你识别到的物体，不要重复提示词正文；
- modeling_prompt 必须是一段可以直接拿去喂图生 3D 模型的完整提示词，按下列小标题分段（无内容的项可省略，但不要写「无」）：
  主体与结构：物体的几何构成、部件关系、整体比例（用「高度约为宽度的 2 倍」这类可量化的描述）
  材质与表面：PBR 语义描述（颜色、粗糙度、金属度、透明/半透明、磨损与纹理）
  风格与参考：造型风格、时代感、参考品类
  拓扑与面数：建议低模/中模、面数量级、是否四边面、UV 与是否需要法线贴图
  展示与光照：用于预览渲染的三点光/柔光等要求
  负向提示：不要出现的元素（文字、水印、人物、多余背景等）
- 最后单起一行给英文关键词（逗号分隔），供只吃英文的模型使用；
- 全程不要编造图片里看不到的结构；不确定的地方写明「推测」而不是当成事实。

输出格式：只输出一个 JSON 对象，不要 Markdown 代码块，不要任何额外文字。
{"message":"给用户的简洁中文回复","commands":[{"name":"director_add_character","arguments_json":"{\\"name\\":\\"角色01\\"}"}]}
- 顶层必须是 message（字符串）和 commands（数组），键名不能改。
- commands 为空数组表示只回答、不操作。
- arguments_json 是「JSON 对象编码成的字符串」，不是嵌套对象。

能力清单：
${JSON.stringify(publicCapabilities())}`;

  const user = `当前完整工程状态：
${JSON.stringify(state)}

最近对话：
${conversation}`;

  // 只取**最后一条用户消息**里的图片：多轮把历史图全塞进去会迅速撑爆上下文，
  // 而「看这张图」的诉求基本都是针对刚发的那张。
  const lastUser = [...messages].reverse().find((item) => item.role === "user");
  const images = imagesOf(lastUser);
  const userContent = images.length > 0
    ? [{ type: "text", text: user }, ...images]
    : user;

  return { system, user, userContent, imageCount: images.length, combined: `${system}\n\n${user}` };
}

function asCommandList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** 白名单过滤 + arguments_json 解析，codex / API 两条通路共用。 */
export function safeDecision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("导演助手返回了无效结果");

  const messageSource = [value.message, value.reply, value.answer, value.text, value.content]
    .find((item) => typeof item === "string" && item.trim());
  if (!messageSource && value.commands === undefined) throw new Error("导演助手返回了无效结果");
  const message = messageSource ? messageSource.trim() : "已完成。";

  const commands = asCommandList(value.commands).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.name !== "string") return [];
    if (!BROWSER_COMMAND_NAMES.has(entry.name)) return [];
    const rawArguments = typeof entry.arguments_json === "string" ? entry.arguments_json : entry.arguments;
    if (typeof rawArguments !== "string" && (!rawArguments || typeof rawArguments !== "object" || Array.isArray(rawArguments))) {
      return [];
    }
    try {
      const argumentsValue = typeof rawArguments === "string" ? JSON.parse(rawArguments || "{}") : rawArguments;
      if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) return [];
      return [{ name: entry.name, arguments: argumentsValue }];
    } catch {
      return [];
    }
  });
  const modelingSource = [value.modeling_prompt, value.modelingPrompt]
    .find((item) => typeof item === "string" && item.trim());
  const modelingPrompt = modelingSource ? modelingSource.trim() : "";

  return { message, commands, modelingPrompt };
}
