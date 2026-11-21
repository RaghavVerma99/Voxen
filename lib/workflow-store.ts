import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { config } from "./config";
import { AppError } from "./errors";
import { errorMessage, logWarning } from "./logger";

export type WorkflowStage =
  | "idle"
  | "collecting"
  | "awaiting_confirmation"
  | "confirmed"
  | "handed_off";

export interface AppointmentDraft {
  startsAt?: string;
  email?: string;
  name?: string;
}

export interface Appointment {
  id: string;
  confirmationCode: string;
  sessionId: string;
  startsAt: string;
  endsAt: string;
  email?: string;
  name?: string;
  status: "confirmed" | "cancelled";
  createdAt: string;
}

export interface WorkflowState {
  sessionId: string;
  stage: WorkflowStage;
  draft: AppointmentDraft;
  appointmentId?: string;
  handoffReason?: string;
  updatedAt: string;
}

interface PersistedState {
  version: 1;
  appointments: Appointment[];
  workflows: Record<string, WorkflowState>;
}

export type BookingResult =
  | { ok: true; appointment: Appointment }
  | { ok: false; reason: "slot_taken" };

function emptyState(): PersistedState {
  return { version: 1, appointments: [], workflows: {} };
}

function storePath(): string {
  return resolve(process.cwd(), config.workflowStorePath);
}

async function readState(): Promise<PersistedState> {
  let raw: string;
  try {
    raw = await readFile(storePath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw err;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.appointments) ||
      !parsed.workflows ||
      typeof parsed.workflows !== "object"
    ) {
      throw new Error("unsupported workflow store version");
    }
    return parsed as PersistedState;
  } catch (err) {
    logWarning("workflow.store_corrupt", { message: errorMessage(err) });
    throw new AppError(
      "CONFIG_ERROR",
      "The persisted workflow store is unreadable.",
      500,
    );
  }
}

async function writeState(state: PersistedState): Promise<void> {
  const target = storePath();
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

/**
 * Serializes read-modify-write cycles even within one process. This prevents
 * two simultaneous confirmations from booking the same slot.
 */
let mutationTail: Promise<void> = Promise.resolve();

async function withState<T>(
  mutation: (state: PersistedState) => T | Promise<T>,
): Promise<T> {
  let release!: () => void;
  const previous = mutationTail;
  mutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  try {
    const state = await readState();
    const result = await mutation(state);
    await writeState(state);
    return result;
  } finally {
    release();
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function confirmationCode(): string {
  return `VXN-${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

function ensureWorkflow(state: PersistedState, sessionId: string): WorkflowState {
  let workflow = state.workflows[sessionId];
  if (!workflow) {
    workflow = {
      sessionId,
      stage: "idle",
      draft: {},
      updatedAt: nowIso(),
    };
    state.workflows[sessionId] = workflow;
  }
  return workflow;
}

export async function getWorkflow(
  sessionId: string,
): Promise<WorkflowState | null> {
  const state = await readState();
  return state.workflows[sessionId] ?? null;
}

export async function updateWorkflow(
  sessionId: string,
  patch: {
    stage?: WorkflowStage;
    draft?: AppointmentDraft;
    handoffReason?: string;
  },
): Promise<WorkflowState> {
  return withState((state) => {
    const workflow = ensureWorkflow(state, sessionId);
    if (patch.stage) workflow.stage = patch.stage;
    if (patch.draft) workflow.draft = { ...workflow.draft, ...patch.draft };
    if (patch.handoffReason !== undefined) {
      workflow.handoffReason = patch.handoffReason;
    }
    workflow.updatedAt = nowIso();
    return workflow;
  });
}

export async function bookAppointment(input: {
  sessionId: string;
  startsAt: string;
  email?: string;
  name?: string;
}): Promise<BookingResult> {
  const parsed = new Date(input.startsAt);
  if (!Number.isFinite(parsed.getTime())) {
    throw new AppError("INVALID_BODY", "Appointment time must be an ISO date", 400);
  }

  return withState((state) => {
    const startsAt = parsed.toISOString();
    const endsAt = new Date(
      Date.parse(startsAt) + config.appointmentMinutes * 60_000,
    ).toISOString();

    const taken = state.appointments.some(
      (item) =>
        item.status === "confirmed" && item.startsAt === startsAt,
    );
    if (taken) return { ok: false, reason: "slot_taken" };

    const appointment: Appointment = {
      id: randomUUID(),
      confirmationCode: confirmationCode(),
      sessionId: input.sessionId,
      startsAt,
      endsAt,
      ...(input.email ? { email: input.email } : {}),
      ...(input.name ? { name: input.name } : {}),
      status: "confirmed",
      createdAt: nowIso(),
    };
    state.appointments.push(appointment);

    const workflow = ensureWorkflow(state, input.sessionId);
    workflow.stage = "confirmed";
    workflow.draft = { startsAt, email: input.email, name: input.name };
    workflow.appointmentId = appointment.id;
    workflow.handoffReason = undefined;
    workflow.updatedAt = nowIso();

    return { ok: true, appointment };
  });
}

export async function cancelAppointment(
  confirmationCode: string,
  sessionId?: string,
): Promise<boolean> {
  return withState((state) => {
    const appointment = state.appointments.find(
      (item) =>
        item.confirmationCode === confirmationCode.toUpperCase().trim() &&
        item.status === "confirmed" &&
        (!sessionId || item.sessionId === sessionId),
    );
    if (!appointment) return false;

    appointment.status = "cancelled";
    if (appointment.sessionId) {
      const workflow = state.workflows[appointment.sessionId];
      if (workflow?.appointmentId === appointment.id) {
        workflow.stage = "idle";
        workflow.appointmentId = undefined;
        workflow.updatedAt = nowIso();
      }
    }
    return true;
  });
}

export async function listAppointments(
  sessionId?: string,
): Promise<Appointment[]> {
  const state = await readState();
  return state.appointments
    .filter(
      (item) =>
        item.status === "confirmed" && (!sessionId || item.sessionId === sessionId),
    )
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export async function workflowStats(): Promise<{
  appointments: number;
  workflows: number;
}> {
  const state = await readState();
  return {
    appointments: state.appointments.filter((item) => item.status === "confirmed")
      .length,
    workflows: Object.keys(state.workflows).length,
  };
}
