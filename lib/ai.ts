import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { config } from "./config";
import { AppError } from "./errors";
import { errorMessage } from "./logger";
import { openaiClient, ensureAiConfigured } from "./openai-client";
import { activeToolSchemas, runTool, type ToolContext } from "./tools";
import { synthesizeSpeech as synthesizeWithFailover } from "./tts";

export { ensureAiConfigured };

const client = openaiClient;

export async function transcribeAudio(
  file: File,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await client().audio.transcriptions.create(
      {
        model: config.sttModel,
        file,
        // gpt-transcribe returns a JSON envelope; request it explicitly and
        // read `.text` rather than relying on the deprecated "text" format.
        response_format: "json",
      },
      { signal },
    );
    return result.text.trim();
  } catch (err) {
    throw new AppError("STT_FAILED", errorMessage(err), 502);
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

export async function generateResponse(
  messages: LlmMessage[],
  context: ToolContext = {},
): Promise<string> {
  const request: LlmMessage[] = messages.slice();

  for (let round = 0; round <= config.maxToolRounds; round += 1) {
    let completion;
    try {
      const params: ChatCompletionCreateParamsNonStreaming = {
        model: config.llmModel,
        messages: request as ChatCompletionMessageParam[],
        tools: activeToolSchemas(),
        // Newer models reject max_tokens; this is the supported cap.
        max_completion_tokens: config.maxReplyTokens,
      };
      if (config.llmReasoningEffort) {
        params.reasoning_effort = config.llmReasoningEffort;
      }
      completion = await client().chat.completions.create(params);
    } catch (err) {
      throw new AppError("LLM_FAILED", errorMessage(err), 502);
    }

    const message = completion.choices[0]?.message;
    const toolCalls = message?.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      const text = (message?.content ?? "").trim();
      return text || "I didn't quite catch that. Could you say it again?";
    }

    const functionCalls = toolCalls.filter(isFunctionCall);
    if (functionCalls.length === 0) {
      throw new AppError("LLM_FAILED", "Received a non-function tool call", 502);
    }

    const assistantMessage: LlmMessage = {
      role: "assistant",
      tool_calls: functionCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
        },
      })),
    };
    if (message?.content) assistantMessage.content = message.content;
    request.push(assistantMessage);

    // Run independent tool calls concurrently but keep result ordering stable.
    const outputs = await Promise.all(
      functionCalls.map(async (call) => ({
        id: call.id,
        output: await runTool(
          call.function.name,
          call.function.arguments || "{}",
          context,
        ),
      })),
    );
    for (const { id, output } of outputs) {
      request.push({ role: "tool", tool_call_id: id, content: output });
    }
  }

  throw new AppError("LLM_FAILED", "Tool loop exceeded maximum iterations", 502);
}

interface PendingToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * Streams the model's text while preserving the same bounded tool loop as
 * generateResponse. Tool calls are accumulated from deltas, executed
 * concurrently, then the model continues with the tool results.
 */
export async function streamResponse(
  messages: LlmMessage[],
  handlers: StreamHandlers,
  context: ToolContext = {},
): Promise<string> {
  const request: LlmMessage[] = messages.slice();
  let fullText = "";

  for (let round = 0; round <= config.maxToolRounds; round += 1) {
    let completion;
    try {
      const params: ChatCompletionCreateParamsStreaming = {
        model: config.llmModel,
        messages: request as ChatCompletionMessageParam[],
        tools: activeToolSchemas(),
        max_completion_tokens: config.maxReplyTokens,
        stream: true,
      };
      if (config.llmReasoningEffort) {
        params.reasoning_effort = config.llmReasoningEffort;
      }
      completion = await client().chat.completions.create(params, {
        signal: handlers.signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new AppError("LLM_FAILED", errorMessage(err), 502);
    }

    let roundText = "";
    const pending = new Map<number, PendingToolCall>();

    try {
      for await (const chunk of completion) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          roundText += delta.content;
          fullText += delta.content;
          handlers.onDelta(delta.content);
        }

        for (const call of delta.tool_calls ?? []) {
          const current = pending.get(call.index) ?? {
            id: "",
            type: "function" as const,
            function: { name: "", arguments: "" },
          };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.function.name += call.function.name;
          if (call.function?.arguments) {
            current.function.arguments += call.function.arguments;
          }
          pending.set(call.index, current);
        }
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new AppError("LLM_FAILED", errorMessage(err), 502);
    }

    const calls = [...pending.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call)
      .filter((call) => call.function.name);

    if (calls.length === 0) {
      const text = fullText.trim();
      if (text) return text;
      const fallback = "I didn't quite catch that. Could you say it again?";
      handlers.onDelta(fallback);
      return fallback;
    }

    const assistantMessage: LlmMessage = {
      role: "assistant",
      tool_calls: calls.map((call, index) => ({
        id: call.id || `call-${round}-${index}`,
        type: "function",
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
        },
      })),
    };
    if (roundText) assistantMessage.content = roundText;
    request.push(assistantMessage);

    const outputs = await Promise.all(
      calls.map(async (call, index) => ({
        id: call.id || `call-${round}-${index}`,
        output: await runTool(
          call.function.name,
          call.function.arguments || "{}",
          context,
        ),
      })),
    );
    for (const { id, output } of outputs) {
      request.push({ role: "tool", tool_call_id: id, content: output });
    }
  }

  throw new AppError("LLM_FAILED", "Tool loop exceeded maximum iterations", 502);
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "APIUserAbortError")
  );
}

// Kept as a re-export so routes and tests continue to import the voice loop's
// speech entry point from one place while the adapter itself is independently
// testable in lib/tts.ts.
export { synthesizeWithFailover as synthesizeSpeech };
