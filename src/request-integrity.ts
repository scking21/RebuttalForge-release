// Public request marker, not a credential. Browsers cannot add this header to a
// simple form/no-cors POST; cross-origin fetches require a successful preflight.
export const OPERATOR_REQUEST_HEADERS = { "x-rebuttalforge-request": "operator" } as const;

export function trustedBrowserOrigins(value?: string): string[] {
  // Both explicitly documented local UI hostnames; never arbitrary loopback
  // ports, subdomains or origins inferred from the incoming request.
  if (value === undefined) return ["http://localhost:5173", "http://127.0.0.1:5173"];
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Browser origin must be one exact HTTP(S) origin"); }
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== value || url.username || url.password) {
    throw new Error("Browser origin must be one exact HTTP(S) origin without a path, credentials or wildcard");
  }
  return [value];
}

export function mutationRequestFailure(request: Request, browserOrigins: readonly string[]) {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  // Never infer trust from Host, the request URL, or forwarded headers. A proxy
  // can supply those, and an attacker-controlled hostname can resolve to loopback.
  if ((origin !== null && !browserOrigins.includes(origin)) ||
      (origin === null && site !== null && !["same-origin", "same-site", "none"].includes(site))) {
    return { error: "untrusted_origin", message: "Mutation requests must come from a configured browser origin." };
  }
  if (request.headers.get("x-rebuttalforge-request") !== OPERATOR_REQUEST_HEADERS["x-rebuttalforge-request"]) {
    return { error: "request_integrity_required", message: "Mutation requests require X-RebuttalForge-Request: operator." };
  }
  // Non-browser clients may omit Origin/Fetch-Metadata, but must deliberately
  // send the marker and the Bearer token whenever operator authentication is set.
  return undefined;
}
