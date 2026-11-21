import type { ChatMessage } from "./conversation";
import type { Appointment, WorkflowState } from "./workflow-store";

export interface PostCallSummary {
  headline: string;
  actionItems: string[];
  decisions: string[];
  transcript: string;
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(iso));
}

function firstUserMessage(history: ChatMessage[]): string {
  const message = history.find((entry) => entry.role === "user")?.content ?? "";
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

/**
 * Deterministic post-call summary. It deliberately avoids another model call:
 * the transcript is already committed, and a local summary is instant, cheap,
 * and reproducible for evals.
 */
export function buildPostCallSummary(
  history: ChatMessage[],
  workflow: WorkflowState | null,
  appointments: Appointment[],
): PostCallSummary {
  const visible = history.filter(
    (entry) => entry.role === "user" || entry.role === "assistant",
  );
  const turns = visible.filter((entry) => entry.role === "user").length;
  const confirmed = appointments[0];
  const actionItems: string[] = [];
  const decisions: string[] = [];

  let headline: string;
  if (confirmed) {
    headline = `Appointment confirmed for ${formatDate(confirmed.startsAt)}. Code ${confirmed.confirmationCode}.`;
    actionItems.push(`Add the ${formatDate(confirmed.startsAt)} appointment to your calendar.`);
    actionItems.push(`Keep confirmation code ${confirmed.confirmationCode} for changes.`);
    decisions.push("The proposed slot was confirmed and persisted.");
  } else if (workflow?.stage === "handed_off") {
    headline = "Conversation handed off to a human.";
    actionItems.push(`A human should follow up: ${workflow.handoffReason ?? "reason not recorded"}.`);
    decisions.push("Automated scheduling was not completed.");
  } else if (workflow?.stage === "awaiting_confirmation" && workflow.draft.startsAt) {
    headline = "An appointment is waiting for your confirmation.";
    actionItems.push(`Confirm or decline ${formatDate(workflow.draft.startsAt)}.`);
    decisions.push("A slot was proposed but not booked.");
  } else {
    headline = `Session finished with ${turns} exchange${turns === 1 ? "" : "s"}.`;
    actionItems.push("No follow-up actions were recorded.");
  }

  const topic = firstUserMessage(visible);
  if (topic) decisions.unshift(`Discussion started with: "${topic}"`);

  return {
    headline,
    actionItems,
    decisions,
    transcript: visible
      .map((entry) => `${entry.role === "user" ? "You" : "Voxen"}: ${entry.content}`)
      .join("\n"),
  };
}
