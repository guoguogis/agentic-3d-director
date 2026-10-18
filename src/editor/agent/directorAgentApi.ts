/** 多模态内容片段：文本或图片（OpenAI 兼容口径） */
export type DirectorAgentContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface DirectorAgentMessage {
  role: "user" | "assistant";
  /** 助手消息可附带一份「图片转 3D 建模提示词」的成品提示词，供一键复制 */
  modelingPrompt?: string;
  /**
   * 纯文本直接用 string；带图时用 parts 数组。
   * 服务端会把最后一条用户消息里的图片转给模型（历史图不重复塞，避免撑爆上下文）。
   */
  content: string | DirectorAgentContentPart[];
}

export interface DirectorAgentChatResult {
  message: string;
  commands: Array<{ name: string; ok: boolean; error?: string }>;
  /** 仅在「看图产出建模提示词」类请求下有值 */
  modelingPrompt?: string;
}

export async function sendDirectorAgentMessage(messages: DirectorAgentMessage[]) {
  const response = await fetch("/api/director-agent/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: DirectorAgentChatResult;
    error?: string;
  };

  if (!response.ok || !body.ok || !body.result) {
    throw new Error(body.error ?? "导演助手暂时不可用，请确认本机 Agent 服务已启动");
  }

  return body.result;
}
