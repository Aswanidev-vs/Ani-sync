import { requestUrl, RequestUrlResponse } from "obsidian";
import type { OpenRouterModel, OpenRouterMessage, ChatCompletionResponse, ModelListResponse } from "./types";

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODELS_CACHE_TTL_MS = 60 * 60 * 1000;

let cachedModels: { apiKey: string; data: OpenRouterModel[]; fetchedAt: number } | null = null;

export async function fetchModels(apiKey: string): Promise<OpenRouterModel[]> {
  const now = Date.now();
  if (cachedModels && cachedModels.apiKey === apiKey && (now - cachedModels.fetchedAt) < MODELS_CACHE_TTL_MS) {
    return cachedModels.data;
  }
  const response: RequestUrlResponse = await requestUrl({
    url: MODELS_URL,
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const json = typeof response.json === "object" && response.json !== null
    ? response.json
    : JSON.parse(response.text);

  if (json && typeof json === "object" && "error" in json) {
    const err = (json as Record<string, unknown>).error as Record<string, unknown> | undefined;
    throw new Error(err?.message as string ?? JSON.stringify(err));
  }

  const body = json as ModelListResponse;
  const models = (body.data ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    pricing: {
      prompt: parseFloat(m.pricing.prompt),
      completion: parseFloat(m.pricing.completion),
    },
    context_length: m.context_length,
    isFree: parseFloat(m.pricing.prompt) === 0 && parseFloat(m.pricing.completion) === 0,
  }));
  cachedModels = { apiKey, data: models, fetchedAt: now };
  return models;
}

export async function sendChat(
  apiKey: string,
  model: string,
  messages: OpenRouterMessage[],
): Promise<string> {
  const response: RequestUrlResponse = await requestUrl({
    url: CHAT_URL,
    method: "POST",
    throw: false,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      temperature: 0.3,
      max_tokens: 2048,
    } satisfies { model: string; messages: OpenRouterMessage[]; stream: boolean; temperature: number; max_tokens: number }),
  });

  if (response.status !== 200) {
    let errorMsg = `OpenRouter returned HTTP ${response.status}`;
    try {
      const errBody = typeof response.json === "object" ? response.json : JSON.parse(response.text);
      if (errBody?.error?.message) errorMsg = errBody.error.message;
      else if (errBody?.error) errorMsg = JSON.stringify(errBody.error);
    } catch { /* ignore */ }
    throw new Error(errorMsg);
  }

  const json = typeof response.json === "object" && response.json !== null
    ? response.json
    : JSON.parse(response.text);

  if (json.error) {
    throw new Error(json.error.message ?? json.error.toString());
  }

  const body = json as ChatCompletionResponse;
  return body.choices?.[0]?.message?.content ?? "";
}

export async function sendChatStream(
  apiKey: string,
  model: string,
  messages: OpenRouterMessage[],
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: 0.3,
      max_tokens: 2048,
    }),
    signal,
  });

  if (!response.ok) {
    let errorMsg = `OpenRouter returned HTTP ${response.status}`;
    try {
      const errBody = await response.json();
      if (errBody?.error?.message) errorMsg = errBody.error.message;
      else if (errBody?.error) errorMsg = JSON.stringify(errBody.error);
    } catch { /* ignore */ }
    throw new Error(errorMsg);
  }

  if (!response.body) {
    throw new Error("OpenRouter did not return a response body.");
  }

  let fullContent = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return fullContent;
      try {
        const chunk = JSON.parse(data);
        const token = chunk.choices?.[0]?.delta?.content ?? "";
        if (token) {
          fullContent += token;
          onToken(token);
        }
      } catch {
        // skip malformed chunks
      }
    }
  }

  return fullContent;
}
