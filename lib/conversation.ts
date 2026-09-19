import { config } from "./config";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export const SYSTEM_PROMPT = `You are a helpful voice assistant speaking through a voice agent. Answer the user's question directly and naturally. Your response is converted to speech, so keep it concise and conversational. Use the search_web tool when you need current, up-to-date information (latest news, releases, prices, events after your training cutoff).`;

const conversations = new Map<string, ChatMessage[]>();

export function getConversation(sessionId: string): ChatMessage[] {
  let conv = conversations.get(sessionId);
  if (!conv) {
    conv = [{ role: "system", content: SYSTEM_PROMPT }];
    conversations.set(sessionId, conv);
  }
  return conv;
}

export function addMessage(
  sessionId: string,
  role: ChatRole,
  content: string,
): ChatMessage[] {
  const conv = getConversation(sessionId);
  conv.push({ role, content });
  if (conv.length > config.maxHistoryMessages + 1) {
    const trimmed = [conv[0], ...conv.slice(-config.maxHistoryMessages)];
    conversations.set(sessionId, trimmed);
  }
  return conv;
}

export function getHistory(sessionId: string): ChatMessage[] {
  return getConversation(sessionId)
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role, content: message.content }));
}

export function reset(sessionId: string): void {
  conversations.delete(sessionId);
}