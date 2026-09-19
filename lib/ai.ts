import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { config } from "./config";
import { AppError } from "./errors";
import { TOOL_SCHEMAS, runTool } from "./tools";

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function client(): OpenAI {
  return new OpenAI({ apiKey: config.openaiApiKey });
}

export async function transcribeAudio(file: File): Promise<string> {
  try {
    const result = await client().audio.transcriptions.create({
      model: config.sttModel,
      file,
      response_format: "text",
    });
    return result.trim();
  } catch (err) {
    throw new AppError("STT_FAILED", errMessage(err), 502);
  }
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface LlmMessage {
  role: string;
  content?: string | null;
  tool_calls?: ToolCall[] | null;
  tool_call_id?: string;
}

function isFunctionCall(
  call: ChatCompletionMessageToolCall,
): call is Extract<ChatCompletionMessageToolCall, { function: unknown }> {
  return "function" in call;
}

export async function generateResponse(messages: LlmMessage[]): Promise<string> {
  const request: LlmMessage[] = messages.slice();
  for (let round = 0; round <= config.maxToolRounds; round += 1) {
    let completion;
    try {
      completion = await client().chat.completions.create({
        model: config.llmModel,
        messages: request as ChatCompletionMessageParam[],
        tools: TOOL_SCHEMAS,
      });
    } catch (err) {
      throw new AppError("LLM_FAILED", errMessage(err), 502);
    }

    const message = completion.choices[0]?.message;
    const toolCalls = message?.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      const text = (message?.content ?? "").trim();
      return text || "I didn't quite get that. Could you repeat it?";
    }

    const functionCalls = toolCalls.filter(isFunctionCall);
    if (functionCalls.length === 0) {
      throw new AppError("LLM_FAILED", "Received a non-function tool call", 502);
    }

    const assistantMessage: LlmMessage = {
      role: "assistant",
      tool_calls: functionCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })),
    };
    if (message?.content) {
      assistantMessage.content = message.content;
    }
    request.push(assistantMessage);

    for (const tc of functionCalls) {
      const output = await runTool(tc.function.name, tc.function.arguments || "{}");
      request.push({
        role: "tool",
        tool_call_id: tc.id,
        content: output,
      });
    }
  }
  throw new AppError("LLM_FAILED", "Tool loop exceeded maximum iterations", 502);
}

export async function synthesizeSpeech(text: string): Promise<string> {
  try {
    const response = await client().audio.speech.create({
      model: config.ttsModel,
      voice: config.ttsVoice,
      response_format: "mp3",
      input: text,
    });
    const audio = await response.arrayBuffer();
    return Buffer.from(audio).toString("base64");
  } catch (err) {
    throw new AppError("TTS_FAILED", errMessage(err), 502);
  }
}