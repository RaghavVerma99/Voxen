import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { config } from "./config";
import { AppError, type ErrorCode } from "./errors";
import { errorMessage, logError } from "./logger";

const GENERIC_SERVER_MESSAGE =
  "The service hit an unexpected error. Please try again in a moment.";

export function toErrorResponse(
  err: unknown,
  requestId: string = randomUUID(),
): NextResponse {
  let code: ErrorCode = "INTERNAL";
  let status = 500;
  let message = GENERIC_SERVER_MESSAGE;

  if (err instanceof AppError) {
    code = err.code;
    status = err.status;
    message =
      config.isProduction && status >= 500 ? GENERIC_SERVER_MESSAGE : err.message;
  }

  logError("request.failed", {
    requestId,
    code,
    status,
    message: err instanceof AppError ? err.message : errorMessage(err),
  });

  return NextResponse.json(
    { detail: { error_code: code, message, request_id: requestId } },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-request-id": requestId,
      },
    },
  );
}

export function jsonOk(
  data: unknown,
  requestId: string,
  status = 200,
): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-request-id": requestId,
    },
  });
}
