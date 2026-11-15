// Workers AI 模型选择：付费账户用 DeepSeek V4.1 Flash，免费账户自动改用 Gemma 4
// DeepSeek V4.1 Flash 不对 Workers Free 开放（调用返回 403 / 错误 5035）。失败一次后记住，一段时间内直接用免费模型；
// 到期再试一次付费模型，这样账户升级到 Workers Paid 后会自动切回来。
// 两个模型都不在 Cloudflare 2026-11-20 的下线名单里（Qwen3-30B-A3B 在名单上，届时返回 410 / 5028）。
import type { Env } from "./env";

export const AI_MODEL_PAID = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
export const AI_MODEL_FREE = "@cf/google/gemma-4-26b-a4b-it";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const RETRY_PAID_MS = 60 * 60 * 1000;
let paidUnavailableUntil = 0;

// 5035：需要 Workers Paid；5028：模型已下线；5007：没有这个模型。这几种换模型能解决；
// 其他错误（每日额度用完 3036、繁忙 3040、超时）换模型也没用，照常抛出
export function needsFreeModel(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e ?? "");
  // 只认 5035 的原文；3036 的提示里也有 "Workers Paid"，不能只匹配这两个词
  return /\b(5035|5028|5007)\b/.test(msg) || /requires a workers paid plan/i.test(msg);
}

// 关闭推理过程（推理模型会先"思考"，占用输出额度、拖慢回复）。DeepSeek 默认 reasoning_effort=high，Gemma 4 只认 enable_thinking
function chatInput(model: string, messages: ChatMessage[], maxTokens: number) {
  const input = { messages, max_completion_tokens: maxTokens, chat_template_kwargs: { enable_thinking: false } };
  return model === AI_MODEL_PAID ? { ...input, reasoning_effort: "none" } : input;
}

export async function runChat(env: Env, messages: ChatMessage[], maxTokens: number): Promise<any> {
  const ai = env.AI!;
  if (Date.now() >= paidUnavailableUntil) {
    try {
      return await ai.run(AI_MODEL_PAID as any, chatInput(AI_MODEL_PAID, messages, maxTokens) as any);
    } catch (e) {
      if (!needsFreeModel(e)) throw e;
      paidUnavailableUntil = Date.now() + RETRY_PAID_MS;
    }
  }
  return ai.run(AI_MODEL_FREE as any, chatInput(AI_MODEL_FREE, messages, maxTokens) as any);
}
