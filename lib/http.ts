import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { config } from "./config";
import { AppError, type ErrorCode, type ErrorHeaders } from "./errors";
import {
  errorMessage,
  logError,
  logEvent,
  logWarning,
} from "./logger";

const GENERIC_SERVER_MESSAGE =
  "The service hit an unexpected error. Please try again in a moment.";

export function toErrorResponse(
  err: unknown,
  requestId: string = randomUUID(),
): NextResponse {
  let code: ErrorCode = "INTERNAL";
  let status = 500;
  let message = GENERIC_SERVER_MESSAGE;
  let extraHeaders: ErrorHeaders | undefined;

  if (err instanceof AppError) {
    code = err.code;
    status = err.status;
    extraHeaders = err.headers;
    message =
      config.isProduction && status >= 500 ? GENERIC_SERVER_MESSAGE : err.message;
  }

  const fields = {
    requestId,
    code,
    status,
    message: err instanceof AppError ? err.message : errorMessage(err),
  };

  // Client mistakes are normal traffic, not server incidents. Reserve error
  // logging for 5xx so alerts are not drowned out by 4xx validation failures.
  if (status >= 500) logError("request.failed", fields);
  else if (status === 401 || status === 429) {
    logWarning("request.rejected", fields);
  } else {
    logEvent("request.rejected", fields);
  }

  return NextResponse.json(
    { detail: { error_code: code, message, request_id: requestId } },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-request-id": requestId,
        ...extraHeaders,
      },
    },
  );
}

export function jsonOk(
  data: unknown,
  requestId: string,
  status = 200,
  headers?: ErrorHeaders,
): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-request-id": requestId,
      ...headers,
    },
  });
}
