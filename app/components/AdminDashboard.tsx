"use client";

import { useCallback, useEffect, useState } from "react";

interface PublicAccount {
  id: string;
  name: string;
  email: string;
  plan: "free" | "pro" | "enterprise";
  role: "user" | "admin";
  status: "active" | "disabled";
  createdAt: string;
}

interface UsageRow {
  accountId: string;
  date: string;
  requests: number;
  audioSeconds: number;
  outputTokens: number;
  costMicros: number;
}

interface UsageReport {
  rows: UsageRow[];
  totals: {
    requests: number;
    audioSeconds: number;
    outputTokens: number;
    costMicros: number;
  };
}

interface BillingLine {
  accountId: string;
  plan: PublicAccount["plan"];
  baseMicros: number;
  requestMicros: number;
  usageMicros: number;
  totalMicros: number;
  requests: number;
  audioSeconds: number;
  outputTokens: number;
}

interface BillingReport {
  lines: BillingLine[];
  totals: {
    baseMicros: number;
    requestMicros: number;
    usageMicros: number;
    totalMicros: number;
  };
}

interface Draft {
  plan: PublicAccount["plan"];
  status: PublicAccount["status"];
}

function money(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

export default function AdminDashboard() {
  const [adminKey, setAdminKey] = useState("");
  const [accounts, setAccounts] = useState<PublicAccount[]>([]);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [billing, setBilling] = useState<BillingReport | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState<PublicAccount["plan"]>("free");
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAdminKey(sessionStorage.getItem("voxen.adminKey") ?? "");
  }, []);

  const request = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (!adminKey) throw new Error("Enter the admin key first.");
      const response = await fetch(path, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-admin-key": adminKey,
          ...init?.headers,
        },
        cache: "no-store",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { detail?: { message?: string } }
          | null;
        throw new Error(
          body?.detail?.message ?? `Request failed (${response.status}).`,
        );
      }
      return (await response.json()) as T;
    },
    [adminKey],
  );

  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const [accountData, usageData, billingData] = await Promise.all([
        request<{ accounts: PublicAccount[] }>("/api/admin/accounts"),
        request<UsageReport>("/api/admin/usage"),
        request<BillingReport>("/api/admin/billing"),
      ]);
      setAccounts(accountData.accounts);
      setUsage(usageData);
      setBilling(billingData);
      setDrafts(
        Object.fromEntries(
          accountData.accounts.map((account) => [
            account.id,
            { plan: account.plan, status: account.status },
          ]),
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [request]);

  function saveKey(value: string) {
    setAdminKey(value);
    if (value) sessionStorage.setItem("voxen.adminKey", value);
    else sessionStorage.removeItem("voxen.adminKey");
  }

  async function createAccount(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNewKey("");
    try {
      const created = await request<{ account: PublicAccount; apiKey: string }>(
        "/api/admin/accounts",
        {
          method: "POST",
          body: JSON.stringify({ name, email, plan }),
        },
      );
      setNewKey(created.apiKey);
      setName("");
      setEmail("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveAccount(account: PublicAccount) {
    const draft = drafts[account.id] ?? {
      plan: account.plan,
      status: account.status,
    };
    setBusy(true);
    setError("");
    try {
      await request("/api/admin/accounts", {
        method: "PATCH",
        body: JSON.stringify({ id: account.id, ...draft }),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="admin-page">
      <header className="admin-header">
        <p className="admin-eyebrow">VOXEN OPERATIONS</p>
        <h1>Accounts and billing</h1>
        <p className="admin-lede">
          Provision API keys, inspect daily quotas, and review metered usage.
        </p>
      </header>

      <section className="admin-panel admin-auth">
        <label className="admin-field">
          Admin key
          <input
            className="admin-input"
            type="password"
            value={adminKey}
            placeholder="x-admin-key"
            onChange={(event) => saveKey(event.target.value)}
          />
        </label>
        <button
          className="admin-button"
          onClick={() => void refresh()}
          disabled={busy}
        >
          {busy ? "Loading…" : "Load dashboard"}
        </button>
      </section>

      {error ? <p className="admin-error">{error}</p> : null}
      {newKey ? (
        <section className="admin-panel admin-new-key">
          <h2>New API key</h2>
          <p className="admin-lede">
            Copy this now. It is shown once and stored only as a hash.
          </p>
          <code className="admin-code">{newKey}</code>
        </section>
      ) : null}

      <div className="admin-grid">
        <section className="admin-panel">
          <h2>Create account</h2>
          <form
            onSubmit={(event) => void createAccount(event)}
            className="admin-form"
          >
            <input
              className="admin-input"
              placeholder="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <input
              className="admin-input"
              placeholder="Email (optional)"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <select
              className="admin-input"
              value={plan}
              onChange={(event) =>
                setPlan(event.target.value as PublicAccount["plan"])
              }
            >
              <option value="free">Free — 50 requests/day</option>
              <option value="pro">Pro — 1,000 requests/day</option>
              <option value="enterprise">Enterprise — 20,000 requests/day</option>
            </select>
            <button className="admin-button" type="submit" disabled={busy}>
              Create
            </button>
          </form>
        </section>

        <section className="admin-panel">
          <h2>Usage totals</h2>
          <dl className="admin-stats">
            <dt>Requests</dt>
            <dd>{usage?.totals.requests ?? 0}</dd>
            <dt>Realtime audio</dt>
            <dd>{Math.round(usage?.totals.audioSeconds ?? 0)}s</dd>
            <dt>Output tokens</dt>
            <dd>{usage?.totals.outputTokens ?? 0}</dd>
            <dt>Metered cost</dt>
            <dd>{money(usage?.totals.costMicros ?? 0)}</dd>
            <dt>Invoiced total</dt>
            <dd>{money(billing?.totals.totalMicros ?? 0)}</dd>
          </dl>
        </section>
      </div>

      <section className="admin-panel admin-table-panel">
        <h2>Accounts</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Role</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => {
                const draft = drafts[account.id] ?? {
                  plan: account.plan,
                  status: account.status,
                };
                return (
                  <tr key={account.id}>
                    <td>
                      {account.name}
                      <br />
                      <small className="admin-sub">
                        {account.email || account.id}
                      </small>
                    </td>
                    <td>
                      <select
                        className="admin-input"
                        value={draft.plan}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [account.id]: {
                              ...draft,
                              plan: event.target.value as PublicAccount["plan"],
                            },
                          }))
                        }
                      >
                        <option value="free">free</option>
                        <option value="pro">pro</option>
                        <option value="enterprise">enterprise</option>
                      </select>
                    </td>
                    <td>
                      <select
                        className="admin-input"
                        value={draft.status}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [account.id]: {
                              ...draft,
                              status: event.target.value as PublicAccount["status"],
                            },
                          }))
                        }
                      >
                        <option value="active">active</option>
                        <option value="disabled">disabled</option>
                      </select>
                    </td>
                    <td>{account.role}</td>
                    <td>
                      <button
                        className="admin-button"
                        onClick={() => void saveAccount(account)}
                        disabled={busy}
                      >
                        Save
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-panel admin-table-panel">
        <h2>Billing by account</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Plan</th>
                <th>Requests</th>
                <th>Base</th>
                <th>Meter</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {(billing?.lines ?? []).map((line) => (
                <tr key={line.accountId}>
                  <td>{line.accountId}</td>
                  <td>{line.plan}</td>
                  <td>{line.requests}</td>
                  <td>{money(line.baseMicros)}</td>
                  <td>{money(line.requestMicros + line.usageMicros)}</td>
                  <td>{money(line.totalMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
