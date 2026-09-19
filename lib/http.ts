import { NextResponse } from "next/server";
import { AppError } from "./errors";

export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof AppError) {
    return NextResponse.json(
      { detail: { error_code: err.code, message: err.message } },
      { status: err.status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json(
    { detail: { error_code: "INTERNAL", message } },
    { status: 500 },
  );
}