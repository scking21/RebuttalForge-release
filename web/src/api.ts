import { ApiError } from "./api-types";
import type { AuditEntry, Backend, SandboxResult } from "./api-types";
import type { Case } from "../../src/domain";
import { fixtureBackend } from "./dev-fixtures";
import { OPERATOR_REQUEST_HEADERS } from "../../src/request-integrity";

const UNREACHABLE = "Cannot reach the API. Check that the server is running on port 4000.";

const TOKEN_KEY = "dispute-desk-operator-token";

function operatorToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  try {
    return await send<T>(method, path, body);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    const entered = window.prompt("This RebuttalForge server needs its operator token.");
    if (!entered) throw e;
    sessionStorage.setItem(TOKEN_KEY, entered);
    return send<T>(method, path, body);
  }
}

async function send<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(method === "POST" ? OPERATOR_REQUEST_HEADERS : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(operatorToken() ? { Authorization: `Bearer ${operatorToken()}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(UNREACHABLE, 0);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const serverMessage =
      typeof json === "object" && json !== null
        ? "message" in json && typeof json.message === "string"
          ? json.message
          : "error" in json && typeof json.error === "string"
            ? json.error
            : undefined
        : undefined;
    const unreachable = [502, 503, 504].includes(res.status);
    throw new ApiError(
      serverMessage ?? (unreachable ? UNREACHABLE : `Request failed: ${res.status} ${res.statusText}`),
      res.status,
    );
  }
  return json as T;
}

const enc = encodeURIComponent;

// The sandbox routes act on PayPal only; reassess pulls the dispute's new state into the case.
async function sandbox(id: string, action: string, body: unknown): Promise<SandboxResult> {
  await request("POST", `/sandbox/disputes/${enc(id)}/${action}`, body);
  return { simulated_resolution: true, case: await request<Case>("POST", `/cases/${enc(id)}/reassess`) };
}

const httpBackend: Backend = {
  health: () => request("GET", "/health"),
  cases: () => request("GET", "/cases"),
  caseDetail: async (id) => {
    const { audit, ...found } = await request<Case & { audit: AuditEntry[] }>("GET", `/cases/${enc(id)}`);
    return { case: found, audit };
  },
  reassess: (id) => request("POST", `/cases/${enc(id)}/reassess`),
  approve: (id, approvedBy, recommendationRevision) => request("POST", `/cases/${enc(id)}/approve`, { approvedBy, recommendationRevision }),
  execute: (id) => request("POST", `/cases/${enc(id)}/execute`),
  requireEvidence: (id) => sandbox(id, "require-evidence", { action: "SELLER_EVIDENCE" }),
  adjudicate: (id, outcome) => sandbox(id, "adjudicate", { outcome }),
};

export const FIXTURE_MODE = new URLSearchParams(window.location.search).has("fixtures");

export const api: Backend = FIXTURE_MODE ? fixtureBackend : httpBackend;

// No auth retry: each catalog search is one explicit request.
export const searchCatalog = (query: string) => send<{ retrievedAt: string; products: { id: string; title: string; description: string | null }[] }>("POST", "/catalog/search", { query });
