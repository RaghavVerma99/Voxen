import type { NextRequest } from "next/server";
import { AppError } from "./errors";

const decoder = new TextDecoder();

/**
 * Reads a request body while enforcing a hard byte limit. Content-Length is
 * checked first so oversized uploads are rejected before they are buffered;
 * the streaming loop covers chunked requests that omit the header.
 */
export async function readBodyWithLimit(
  request: NextRequest,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0) {
      throw new AppError("INVALID_BODY", "Invalid Content-Length header", 400);
    }
    if (length > maxBytes) {
      throw payloadTooLarge(maxBytes);
    }
  }

  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw payloadTooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readJson<T>(
  request: NextRequest,
  maxBytes: number,
): Promise<T | null> {
  const bytes = await readBodyWithLimit(request, maxBytes);
  if (bytes.byteLength === 0) return null;

  try {
    return JSON.parse(decoder.decode(bytes)) as T;
  } catch {
    throw new AppError("INVALID_BODY", "Request body must be valid JSON", 400);
  }
}

export async function readFormData(
  request: NextRequest,
  maxBytes: number,
): Promise<FormData> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new AppError(
      "INVALID_BODY",
      "Expected a multipart/form-data request",
      400,
    );
  }

  const bytes = await readBodyWithLimit(request, maxBytes);

  try {
    return await new Response(bytes, {
      headers: { "content-type": contentType },
    }).formData();
  } catch {
    throw new AppError("INVALID_BODY", "Malformed multipart body", 400);
  }
}

function payloadTooLarge(maxBytes: number): AppError {
  return new AppError(
    "PAYLOAD_TOO_LARGE",
    `Request body exceeds the ${Math.floor(maxBytes / 1024)} KB limit`,
    413,
  );
}
