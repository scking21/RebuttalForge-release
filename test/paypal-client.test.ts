import { describe, expect, it } from "vitest";
import {
  PayPalClient,
  PayPalError,
  assertSandboxOnly,
  loadPayPalConfig,
  type Exchange,
} from "../src/paypal/client.js";

const config = { baseUrl: "https://api-m.sandbox.paypal.com", clientId: "id", clientSecret: "secret" };

interface Seen {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

function stub(routes: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const s = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    };
    seen.push(s);
    if (s.url.endsWith("/v1/oauth2/token")) {
      return Response.json({ access_token: "tok", expires_in: 32400 });
    }
    return routes(s);
  };
  return { seen, fetchStub };
}

describe("sandbox-only guard", () => {
  it("refuses the live host and accepts sandbox and loopback", () => {
    expect(() => assertSandboxOnly("https://api-m.paypal.com")).toThrow(/live PayPal host/);
    expect(() => new PayPalClient({ ...config, baseUrl: "https://api-m.paypal.com/" })).toThrow(/sandbox only/);
    expect(() => assertSandboxOnly("https://api-m.sandbox.paypal.com")).not.toThrow();
    expect(() => assertSandboxOnly("http://localhost:4010")).not.toThrow();
  });

  it("defaults the base URL to the sandbox", () => {
    const cfg = loadPayPalConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" });
    expect(cfg.baseUrl).toBe("https://api-m.sandbox.paypal.com");
  });
});

describe("PayPalClient wire format", () => {
  it("fetches one token with basic auth and reuses it", async () => {
    const { seen, fetchStub } = stub(() => Response.json({ id: "O1", status: "CREATED" }));
    const client = new PayPalClient(config, { fetch: fetchStub });
    await client.getOrder("O1");
    await client.getOrder("O1");
    const tokenCalls = seen.filter((s) => s.url.endsWith("/v1/oauth2/token"));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.headers.get("authorization")).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);
    expect(tokenCalls[0]?.body).toBe("grant_type=client_credentials");
    expect(seen.at(-1)?.headers.get("authorization")).toBe("Bearer tok");
  });

  it("sends provide-evidence as multipart with a JSON part named input and PayPal-Request-Id", async () => {
    const { seen, fetchStub } = stub(() => Response.json({ links: [] }));
    const client = new PayPalClient(config, { fetch: fetchStub });
    await client.provideEvidence(
      "PP-D-1",
      { evidenceType: "PROOF_OF_FULFILLMENT", tracking: { carrierName: "UPS", trackingNumber: "1Z" }, notes: "n" },
      "req-1",
    );
    const call = seen.at(-1)!;
    expect(call.url).toBe("https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/provide-evidence");
    expect(call.headers.get("paypal-request-id")).toBe("req-1");
    expect(call.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    expect(call.body).toContain('Content-Disposition: form-data; name="input"\r\nContent-Type: application/json');
    const json = call.body.split("\r\n\r\n")[1]!.split("\r\n--")[0]!;
    expect(JSON.parse(json)).toEqual({
      evidences: [
        {
          evidence_type: "PROOF_OF_FULFILLMENT",
          evidence_info: { tracking_info: [{ carrier_name: "UPS", tracking_number: "1Z" }] },
          notes: "n",
        },
      ],
    });
  });

  it("throws PayPalError carrying status, name, debug id and the raw body", async () => {
    const body = { name: "UNPROCESSABLE_ENTITY", message: "nope", debug_id: "dbg1", details: [{ issue: "X" }] };
    const { fetchStub } = stub(() => Response.json(body, { status: 422 }));
    const exchanges: Exchange[] = [];
    const client = new PayPalClient(config, { fetch: fetchStub, onExchange: (e) => exchanges.push(e) });
    const err = await client.escalate("PP-D-1", "note", "r").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({ status: 422, name: "UNPROCESSABLE_ENTITY", debugId: "dbg1", body });
    expect(exchanges.at(-1)).toMatchObject({ status: 422, responseBody: body });
    expect(exchanges.every((e) => e.requestHeaders.Authorization === "REDACTED" || !e.requestHeaders.Authorization)).toBe(true);
  });
});

describe('capture response representation recovery', () => {
  const complete = { id: 'O1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'C1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '48.00' } }] } }] };

  it('follows a documented minimal capture response with GET details and never repeats capture POST', async () => {
    const { seen, fetchStub } = stub(s => s.url.endsWith('/capture')
      ? Response.json({ id: 'O1', status: 'COMPLETED', links: [] })
      : Response.json(complete));
    const client = new PayPalClient(config, { fetch: fetchStub });
    const order = await client.captureOrder('O1', 'capture-request');
    expect(order.purchase_units[0]?.payments?.captures?.[0]?.id).toBe('C1');
    expect(seen.filter(s => !s.url.endsWith('/v1/oauth2/token')).map(s => `${s.method} ${new URL(s.url).pathname}`)).toEqual(['POST /v2/checkout/orders/O1/capture', 'GET /v2/checkout/orders/O1']);
  });

  it('reports unavailable capture identity after one detail read instead of recapturing', async () => {
    const { seen, fetchStub } = stub(() => Response.json({ id: 'O1', status: 'COMPLETED' }));
    const client = new PayPalClient(config, { fetch: fetchStub });
    await expect(client.captureOrder('O1', 'capture-request')).rejects.toThrow(/Capture was acknowledged/);
    expect(seen.filter(s => s.url.endsWith('/capture'))).toHaveLength(1);
  });
});

describe('installed client capture and refund-offer contracts', () => {
  const complete = { id: 'O1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'C1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '48.00' } }] } }] };

  it('parses a full capture representation without a redundant order read', async () => {
    const { seen, fetchStub } = stub(() => Response.json(complete));
    const order = await new PayPalClient(config, { fetch: fetchStub }).captureOrder('O1', 'request-full');
    expect(order.purchase_units[0]?.payments?.captures?.[0]?.id).toBe('C1');
    const calls = seen.filter(s => !s.url.endsWith('/v1/oauth2/token'));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.get('paypal-request-id')).toBe('request-full');
  });

  for (const where of ['capture', 'detail']) {
    it(`rejects a mismatched ${where} order identity without repeating the capture`, async () => {
      const { seen, fetchStub } = stub(s => Response.json(s.url.endsWith('/capture')
        ? where === 'capture' ? { ...complete, id: 'OTHER' } : { id: 'O1', status: 'COMPLETED' }
        : { ...complete, id: 'OTHER' }));
      await expect(new PayPalClient(config, { fetch: fetchStub }).captureOrder('O1', 'request-mismatch')).rejects.toThrow(/order identity mismatch/);
      expect(seen.filter(s => s.url.endsWith('/capture'))).toHaveLength(1);
      expect(seen.filter(s => s.method === 'GET')).toHaveLength(where === 'capture' ? 0 : 1);
    });
  }

  it('rejects malformed capture details using the actual schema without recapturing', async () => {
    const { seen, fetchStub } = stub(s => Response.json(s.url.endsWith('/capture')
      ? { id: 'O1', status: 'COMPLETED' }
      : { ...complete, purchase_units: [{ payments: { captures: [{ id: 'C1' }] } }] }));
    await expect(new PayPalClient(config, { fetch: fetchStub }).captureOrder('O1', 'request-malformed')).rejects.toMatchObject({ name: 'ZodError' });
    expect(seen.filter(s => s.url.endsWith('/capture'))).toHaveLength(1);
    expect(seen.filter(s => s.method === 'GET')).toHaveLength(1);
  });

  it('surfaces a failed details lookup after acknowledgement without recapturing', async () => {
    const { seen, fetchStub } = stub(s => s.url.endsWith('/capture')
      ? Response.json({ id: 'O1', status: 'COMPLETED' })
      : Response.json({ name: 'RESOURCE_NOT_FOUND', message: 'Synthetic delayed visibility' }, { status: 404 }));
    await expect(new PayPalClient(config, { fetch: fetchStub }).captureOrder('O1', 'request-unavailable')).rejects.toMatchObject({ status: 404, name: 'RESOURCE_NOT_FOUND' });
    expect(seen.filter(s => s.url.endsWith('/capture'))).toHaveLength(1);
    expect(seen.filter(s => s.method === 'GET')).toHaveLength(1);
  });

  for (const offerType of ['REFUND_WITH_RETURN', 'REFUND_WITH_REPLACEMENT', 'REPLACEMENT_WITHOUT_REFUND']) {
    it(`rejects unsupported ${offerType} before any fetch`, () => {
      const { seen, fetchStub } = stub(() => { throw new Error('Unexpected dispatch'); });
      const client = new PayPalClient(config, { fetch: fetchStub });
      expect(() => client.makeOffer('D1', { note: 'Synthetic', offerType: offerType as 'REFUND', amount: { currency_code: 'USD', value: '10.00' } }, 'offer-request')).toThrow(/Only REFUND/);
      expect(seen).toHaveLength(0);
    });
  }

  it('sends the supported REFUND body and request identity through the actual client', async () => {
    const { seen, fetchStub } = stub(() => Response.json({ links: [] }));
    const client = new PayPalClient(config, { fetch: fetchStub });
    await client.makeOffer('D1', { note: 'Synthetic partial refund', offerType: 'REFUND', amount: { currency_code: 'USD', value: '10.00' } }, 'offer-request');
    const call = seen.at(-1)!;
    expect(call.method).toBe('POST');
    expect(new URL(call.url).pathname).toBe('/v1/customer/disputes/D1/make-offer');
    expect(call.headers.get('paypal-request-id')).toBe('offer-request');
    expect(JSON.parse(call.body)).toEqual({ note: 'Synthetic partial refund', offer_type: 'REFUND', offer_amount: { currency_code: 'USD', value: '10.00' } });
  });
});

describe('documented no-attachment dispute action JSON bodies', () => {
  it('sends accept-claim as JSON with REFUND subtype and request identity', async () => {
    const { seen, fetchStub } = stub(() => Response.json({ links: [] }));
    await new PayPalClient(config, { fetch: fetchStub }).acceptClaim('D1', { note: 'Synthetic acceptance' }, 'accept-json');
    const call = seen.at(-1)!;
    expect(new URL(call.url).pathname).toBe('/v1/customer/disputes/D1/accept-claim');
    expect(call.method).toBe('POST');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.headers.get('paypal-request-id')).toBe('accept-json');
    expect(JSON.parse(call.body)).toEqual({ note: 'Synthetic acceptance', accept_claim_type: 'REFUND' });
    expect(call.body).not.toContain('accept-claim-document');
  });

  it('sends send-message as JSON without inventing a document attachment', async () => {
    const { seen, fetchStub } = stub(() => Response.json({ links: [] }));
    await new PayPalClient(config, { fetch: fetchStub }).sendMessage('D1', 'Synthetic message', 'message-json');
    const call = seen.at(-1)!;
    expect(new URL(call.url).pathname).toBe('/v1/customer/disputes/D1/send-message');
    expect(call.method).toBe('POST');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.headers.get('paypal-request-id')).toBe('message-json');
    expect(JSON.parse(call.body)).toEqual({ message: 'Synthetic message' });
    expect(call.body).not.toContain('message_document');
  });
});
