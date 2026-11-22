import { config } from "./config";
import { AppError } from "./errors";
import type { ToolSchema } from "./tools";
import {
  cancelAppointment,
  confirmReservation,
  listAppointments,
  prepareConfirmation,
  updateWorkflow,
  type WorkflowSource,
} from "./workflow-store";

export const WORKFLOW_TOOL_NAMES = new Set([
  "find_appointment_slots",
  "prepare_appointment",
  "confirm_appointment",
  "cancel_appointment",
  "handoff_to_human",
]);

export const WORKFLOW_TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "find_appointment_slots",
      description:
        "Find up to five open appointment slots on a weekday between 09:00 and 17:00 UTC. Use this before proposing a time.",
      parameters: {
        type: "object",
        properties: {
          day: {
            type: "string",
            description: "A date in YYYY-MM-DD format. Defaults to tomorrow.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_appointment",
      description:
        "Record a proposed appointment time and contact detail. Does not book anything; the user must confirm afterward.",
      parameters: {
        type: "object",
        properties: {
          starts_at: {
            type: "string",
            description: "The proposed ISO 8601 start time.",
          },
          email: {
            type: "string",
            description: "Contact email for the appointment.",
          },
          name: { type: "string", description: "Optional caller name." },
        },
        required: ["starts_at", "email"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_appointment",
      description:
        "Book the prepared appointment. Only call this after the user clearly confirms. Pass the one-time confirmation_token returned by prepare_appointment.",
      parameters: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            description: "Must be true after the user explicitly agrees.",
          },
          confirmation_token: {
            type: "string",
            description: "The one-time token returned by prepare_appointment.",
          },
        },
        required: ["confirm", "confirmation_token"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_appointment",
      description: "Cancel a confirmed appointment using its confirmation code.",
      parameters: {
        type: "object",
        properties: {
          confirmation_code: { type: "string" },
        },
        required: ["confirmation_code"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "handoff_to_human",
      description:
        "Escalate to a human when the user asks, the request is outside scheduling, or two attempts have failed.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why a human is needed." },
        },
        required: ["reason"],
        additionalProperties: false,
      },
    },
  },
];

function argsOf(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson || "{}") as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value.trim() : undefined;
}

function failure(reason: string): string {
  return JSON.stringify({ ok: false, reason });
}

function validDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

function defaultDay(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export async function findAppointmentSlots(dayInput?: string): Promise<string> {
  const day = dayInput?.trim() || defaultDay();
  if (!validDay(day)) return failure("invalid day; use YYYY-MM-DD");

  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return JSON.stringify({ ok: true, day, slots: [] });
  }

  const taken = new Set((await listAppointments()).map((item) => item.startsAt));
  const stepMs = config.appointmentMinutes * 60_000;
  const openAt = Date.parse(`${day}T09:00:00.000Z`);
  const closeAt = Date.parse(`${day}T17:00:00.000Z`);
  const slots: string[] = [];

  for (let time = openAt; time + stepMs <= closeAt && slots.length < 5; time += stepMs) {
    const iso = new Date(time).toISOString();
    if (!taken.has(iso)) slots.push(iso);
  }

  return JSON.stringify({ ok: true, day, slots });
}

function validateStartsAt(startsAt: string): Date | null {
  const date = new Date(startsAt);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) return null;

  const weekday = date.getUTCDay();
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const closeMinutes = 17 * 60 - config.appointmentMinutes;
  if (
    weekday === 0 ||
    weekday === 6 ||
    minutes < 9 * 60 ||
    minutes > closeMinutes ||
    date.getUTCSeconds() !== 0 ||
    minutes % config.appointmentMinutes !== 0
  ) {
    return null;
  }
  return date;
}

export async function prepareAppointment(
  sessionId: string | undefined,
  argumentsJson: string,
): Promise<string> {
  if (!sessionId) return failure("session is required");
  const args = argsOf(argumentsJson);
  const startsAt = stringArg(args, "starts_at");
  const email = stringArg(args, "email");
  const name = stringArg(args, "name");

  if (!startsAt || !validateStartsAt(startsAt)) {
    return failure("choose a future weekday slot between 09:00 and 17:00 UTC");
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return failure("a valid email is required");
  }

  const prepared = await prepareConfirmation({
    sessionId,
    startsAt,
    email,
    ...(name ? { name } : {}),
  });

  return JSON.stringify({
    ok: true,
    starts_at: prepared.startsAt,
    ends_at: prepared.endsAt,
    confirmation_token: prepared.token,
    confirmation_expires_at: prepared.expiresAt,
    requires_confirmation: true,
  });
}

export async function confirmAppointment(
  sessionId: string | undefined,
  argumentsJson: string,
  source: WorkflowSource,
): Promise<string> {
  if (!sessionId) return failure("session is required");
  const args = argsOf(argumentsJson);
  if (args.confirm !== true) return failure("explicit confirmation is required");
  const token = stringArg(args, "confirmation_token");
  if (!token || token.length > 256) {
    return failure("a valid one-time confirmation token is required");
  }

  const result = await confirmReservation({ sessionId, token, source });
  if (!result.ok) {
    const reasons: Record<typeof result.reason, string> = {
      no_preparation: "no prepared appointment to confirm",
      invalid_token: "the confirmation token is invalid",
      expired_token: "the confirmation token expired; prepare the slot again",
      slot_taken: "that slot was just taken; choose another",
    };
    return failure(reasons[result.reason]);
  }

  return JSON.stringify({
    ok: true,
    confirmation_code: result.appointment.confirmationCode,
    starts_at: result.appointment.startsAt,
    ends_at: result.appointment.endsAt,
  });
}

export async function cancelFromTool(
  argumentsJson: string,
  source: WorkflowSource,
): Promise<string> {
  const code = stringArg(argsOf(argumentsJson), "confirmation_code");
  if (!code) return failure("confirmation code is required");
  const cancelled = await cancelAppointment(code, undefined, source);
  return JSON.stringify({ ok: cancelled, ...(cancelled ? {} : { reason: "not found" }) });
}

export async function requestHumanHandoff(
  sessionId: string | undefined,
  argumentsJson: string,
): Promise<string> {
  const reason = stringArg(argsOf(argumentsJson), "reason") || "unspecified";
  if (sessionId) {
    await updateWorkflow(sessionId, {
      stage: "handed_off",
      handoffReason: reason,
    });
  }
  return JSON.stringify({ ok: true, handoff: true, reason });
}

/** Runs a workflow tool with the server-owned session id, never a model-supplied one. */
export async function runWorkflowTool(
  name: string,
  argumentsJson: string,
  sessionId?: string,
  source: WorkflowSource = "system",
): Promise<string | null> {
  switch (name) {
    case "find_appointment_slots":
      return findAppointmentSlots(stringArg(argsOf(argumentsJson), "day"));
    case "prepare_appointment":
      return prepareAppointment(sessionId, argumentsJson);
    case "confirm_appointment":
      return confirmAppointment(sessionId, argumentsJson, source);
    case "cancel_appointment":
      return cancelFromTool(argumentsJson, source);
    case "handoff_to_human":
      return requestHumanHandoff(sessionId, argumentsJson);
    default:
      return null;
  }
}

export function workflowDisabledError(): AppError {
  return new AppError(
    "CONFIG_ERROR",
    "The scheduling workflow is disabled.",
    503,
  );
}
