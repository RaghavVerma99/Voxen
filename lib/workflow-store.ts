import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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

export type WorkflowSource = "sse" | "realtime" | "system";

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
  source: WorkflowSource;
  createdBy: WorkflowSource;
  confirmedAt: string;
  cancelledAt?: string;
  cancelledBy?: WorkflowSource;
}

export interface WorkflowState {
  sessionId: string;
  stage: WorkflowStage;
  draft: AppointmentDraft;
  appointmentId?: string;
  handoffReason?: string;
  /** Hash of the one-time token returned by prepare_appointment. */
  confirmationTokenHash?: string;
  confirmationExpiresAt?: string;
  updatedAt: string;
}

export interface SharedTranscript {
  token: string;
  sessionId: string;
  summary: string;
  transcript: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}

interface PersistedState {
  version: 1;
  appointments: Appointment[];
  workflows: Record<string, WorkflowState>;
  shares?: Record<string, SharedTranscript>;
}

export type BookingResult =
  | { ok: true; appointment: Appointment }
  | { ok: false; reason: "slot_taken" };

export type ConfirmationResult =
  | { ok: true; appointment: Appointment }
  | {
      ok: false;
      reason: "no_preparation" | "invalid_token" | "expired_token" | "slot_taken";
    };

function emptyState(): PersistedState {
  return { version: 1, appointments: [], workflows: {}, shares: {} };
}

function storePath(): string {
  // The path is deployment configuration, not a bundler-time asset lookup.
  // The hint keeps Turbopack from tracing the whole project into the output.
  return resolve(/* turbopackIgnore: true */ process.cwd(), config.workflowStorePath);
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
    const state = parsed as PersistedState;
    return {
      version: 1,
      appointments: state.appointments.map((item) => ({
        ...item,
        source: item.source ?? "system",
        createdBy: item.createdBy ?? item.source ?? "system",
        confirmedAt: item.confirmedAt ?? item.createdAt,
        ...(item.status === "cancelled"
          ? {
              cancelledAt: item.cancelledAt ?? item.createdAt,
              cancelledBy: item.cancelledBy ?? "system",
            }
          : {}),
      })),
      workflows: state.workflows,
      shares:
        parsed.shares && typeof parsed.shares === "object" ? parsed.shares : {},
    };
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

function hashConfirmationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Hashes are fixed-length hex strings, so a constant-time compare is safe. */
function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length === 64 && timingSafeEqual(a, b);
}

/** Confirmation secrets and share metadata stay server-side in public payloads. */
function publicWorkflow(workflow: WorkflowState | null): WorkflowState | null {
  if (!workflow) return null;
  const {
    confirmationTokenHash: _hash,
    confirmationExpiresAt: _expiresAt,
    ...safe
  } = workflow;
  return safe;
}

function clearConfirmation(workflow: WorkflowState): void {
  workflow.confirmationTokenHash = undefined;
  workflow.confirmationExpiresAt = undefined;
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
  return publicWorkflow(state.workflows[sessionId] ?? null);
}

export async function updateWorkflow(
  sessionId: string,
  patch: {
    stage?: WorkflowStage;
    draft?: AppointmentDraft;
    handoffReason?: string;
    confirmationTokenHash?: string;
    confirmationExpiresAt?: string;
  },
): Promise<WorkflowState> {
  return withState((state) => {
    const workflow = ensureWorkflow(state, sessionId);
    if (patch.stage) workflow.stage = patch.stage;
    if (patch.draft) workflow.draft = { ...workflow.draft, ...patch.draft };
    if (patch.handoffReason !== undefined) {
      workflow.handoffReason = patch.handoffReason;
    }
    if (patch.confirmationTokenHash !== undefined) {
      workflow.confirmationTokenHash = patch.confirmationTokenHash;
    }
    if (patch.confirmationExpiresAt !== undefined) {
      workflow.confirmationExpiresAt = patch.confirmationExpiresAt;
    }
    workflow.updatedAt = nowIso();
    return publicWorkflow(workflow)!;
  });
}

function bookInState(
  state: PersistedState,
  input: {
    sessionId: string;
    startsAt: string;
    email?: string;
    name?: string;
    source: WorkflowSource;
  },
): BookingResult {
  const startsAt = new Date(input.startsAt).toISOString();
  const endsAt = new Date(
    Date.parse(startsAt) + config.appointmentMinutes * 60_000,
  ).toISOString();

  const taken = state.appointments.some(
    (item) => item.status === "confirmed" && item.startsAt === startsAt,
  );
  if (taken) return { ok: false, reason: "slot_taken" };

  const createdAt = nowIso();
  const appointment: Appointment = {
    id: randomUUID(),
    confirmationCode: confirmationCode(),
    sessionId: input.sessionId,
    startsAt,
    endsAt,
    ...(input.email ? { email: input.email } : {}),
    ...(input.name ? { name: input.name } : {}),
    status: "confirmed",
    createdAt,
    source: input.source,
    createdBy: input.source,
    confirmedAt: createdAt,
  };
  state.appointments.push(appointment);

  const workflow = ensureWorkflow(state, input.sessionId);
  workflow.stage = "confirmed";
  workflow.draft = { startsAt, email: input.email, name: input.name };
  workflow.appointmentId = appointment.id;
  workflow.handoffReason = undefined;
  clearConfirmation(workflow);
  workflow.updatedAt = createdAt;

  return { ok: true, appointment };
}

export async function bookAppointment(input: {
  sessionId: string;
  startsAt: string;
  email?: string;
  name?: string;
  source?: WorkflowSource;
}): Promise<BookingResult> {
  const parsed = new Date(input.startsAt);
  if (!Number.isFinite(parsed.getTime())) {
    throw new AppError("INVALID_BODY", "Appointment time must be an ISO date", 400);
  }

  return withState((state) =>
    bookInState(state, {
      sessionId: input.sessionId,
      startsAt: parsed.toISOString(),
      email: input.email,
      name: input.name,
      source: input.source ?? "system",
    }),
  );
}

export async function prepareConfirmation(input: {
  sessionId: string;
  startsAt: string;
  email?: string;
  name?: string;
}): Promise<{ token: string; expiresAt: string; startsAt: string; endsAt: string }> {
  const startsAt = new Date(input.startsAt).toISOString();
  const endsAt = new Date(
    Date.parse(startsAt) + config.appointmentMinutes * 60_000,
  ).toISOString();
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(
    Date.now() + Math.max(0, config.confirmationTtlMs),
  ).toISOString();

  await withState((state) => {
    const workflow = ensureWorkflow(state, input.sessionId);
    workflow.stage = "awaiting_confirmation";
    workflow.draft = { startsAt, email: input.email, ...(input.name ? { name: input.name } : {}) };
    workflow.confirmationTokenHash = hashConfirmationToken(token);
    workflow.confirmationExpiresAt = expiresAt;
    workflow.appointmentId = undefined;
    workflow.handoffReason = undefined;
    workflow.updatedAt = nowIso();
  });

  return { token, expiresAt, startsAt, endsAt };
}

export async function confirmReservation(input: {
  sessionId: string;
  token: string;
  source: WorkflowSource;
}): Promise<ConfirmationResult> {
  return withState((state) => {
    const workflow = state.workflows[input.sessionId];
    if (
      !workflow ||
      workflow.stage !== "awaiting_confirmation" ||
      !workflow.draft.startsAt ||
      !workflow.confirmationTokenHash
    ) {
      return { ok: false as const, reason: "no_preparation" };
    }

    const expiresAt = workflow.confirmationExpiresAt
      ? Date.parse(workflow.confirmationExpiresAt)
      : Number.NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      clearConfirmation(workflow);
      workflow.stage = "collecting";
      workflow.updatedAt = nowIso();
      return { ok: false as const, reason: "expired_token" };
    }

    if (!sameHash(hashConfirmationToken(input.token), workflow.confirmationTokenHash)) {
      return { ok: false as const, reason: "invalid_token" };
    }

    // The token is single-use; consume it before side effects so a retry needs
    // a fresh prepare step even if the slot was taken in the meantime.
    clearConfirmation(workflow);
    return bookInState(state, {
      sessionId: input.sessionId,
      startsAt: workflow.draft.startsAt,
      email: workflow.draft.email,
      name: workflow.draft.name,
      source: input.source,
    });
  });
}

export async function cancelAppointment(
  confirmationCode: string,
  sessionId?: string,
  source: WorkflowSource = "system",
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
    appointment.cancelledAt = nowIso();
    appointment.cancelledBy = source;
    if (appointment.sessionId) {
      const workflow = state.workflows[appointment.sessionId];
      if (workflow?.appointmentId === appointment.id) {
        workflow.stage = "idle";
        workflow.appointmentId = undefined;
        clearConfirmation(workflow);
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

export async function createShare(input: {
  sessionId: string;
  summary: string;
  transcript: string;
}): Promise<SharedTranscript> {
  return withState((state) => {
    const shares = state.shares ?? {};
    let token = randomUUID().replace(/-/g, "");
    while (shares[token]) token = randomUUID().replace(/-/g, "");

    const createdAt = nowIso();
    const share: SharedTranscript = {
      token,
      sessionId: input.sessionId,
      summary: input.summary,
      transcript: input.transcript,
      createdAt,
      expiresAt: new Date(
        Date.parse(createdAt) + Math.max(0, config.shareTtlMs),
      ).toISOString(),
    };
    shares[token] = share;
    state.shares = shares;
    return share;
  });
}

export async function getShare(token: string): Promise<SharedTranscript | null> {
  const state = await readState();
  const share = state.shares?.[token];
  if (!share || share.revokedAt) return null;
  const expiresAt = share.expiresAt ? Date.parse(share.expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return share;
}

export async function revokeShare(
  token: string,
  sessionId: string,
): Promise<boolean> {
  return withState((state) => {
    const share = state.shares?.[token];
    if (!share || share.sessionId !== sessionId || share.revokedAt) return false;
    share.revokedAt = nowIso();
    return true;
  });
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
