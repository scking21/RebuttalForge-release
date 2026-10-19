import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicModel, ModelError, SYSTEM_PROMPT, modelFromEnv, type ModelInput } from "../src/agent/model.js";

const input: ModelInput = {
  dispute: { disputeId: "PP-D-1", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", stage: "INQUIRY", status: "OPEN", amount: { currency_code: "USD", value: "48.00" } },
  evidence: [{ id: "E1", source: "paypal.dispute", label: "l", fact: "f", ref: "r", observedAt: "t" }],
  permittedActions: ["concede"],
};

function fakeClient(response: Record<string, unknown>) {
  const calls: any[] = [];
  const client = {
    messages: {
      parse: async (params: unknown) => {
        calls.push(params);
        return response;
      },
    },
  } as unknown as Pick<Anthropic, "messages">;
  return { client, calls };
}

const parsed = {
  kind: "actionable",
  recommendation: {
  action: "concede",
  confidence: "high",
  summary: "s",
  supports: [{ text: "t", evidenceIds: ["E1"] }],
  contradicts: [],
  draft: { note: "n" },
  },
};

describe("AnthropicModel", () => {
  it("sends the evidence as data with a structured-output schema, never a forced tool_choice", async () => {
    const { client, calls } = fakeClient({ stop_reason: "end_turn", parsed_output: parsed });
    const model = new AnthropicModel({ apiKey: "k", client });
    expect(await model.recommend(input)).toEqual(parsed);

    const params = calls[0];
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.system).toBe(SYSTEM_PROMPT);
    expect(params.tool_choice).toBeUndefined();
    expect(JSON.parse(params.messages[0].content)).toMatchObject({ permittedActions: ["concede"], evidence: [{ id: "E1" }] });
    expect(params.output_config.format.type).toBe("json_schema");
    const branches = params.output_config.format.schema.anyOf;
    expect(branches).toHaveLength(2);
    expect(branches[0].required).toEqual(expect.arrayContaining(["kind", "reason", "summary", "evidenceIds", "reviewerNextStep"]));
    expect(branches[1].required).toEqual(["kind", "recommendation"]);
    expect(branches[0].properties.kind.description).toContain("hold");
    expect(branches[1].properties.kind.description).toContain("actionable");
  });

  it("states the rules the guard depends on", () => {
    expect(SYSTEM_PROMPT).toMatch(/Cite evidence ids for every claim/);
    expect(SYSTEM_PROMPT).toMatch(/Recommend "concede"/);
    expect(SYSTEM_PROMPT).toMatch(/only from the permitted actions/);
    expect(SYSTEM_PROMPT).toMatch(/under 2000 characters/);
    expect(SYSTEM_PROMPT).toMatch(/Never invent facts/);
  });

  it("classifies stop reasons when the injected parse client returns a response", async () => {
    for (const response of [
      { stop_reason: "refusal", stop_details: { category: "cyber" }, parsed_output: null },
      { stop_reason: "max_tokens", parsed_output: null },
      { stop_reason: "end_turn", parsed_output: null },
    ]) {
      const model = new AnthropicModel({ apiKey: "k", client: fakeClient(response).client });
      await expect(model.recommend(input)).rejects.toBeInstanceOf(ModelError);
    }
  });

  it("is only built from the environment when an API key is set", () => {
    expect(modelFromEnv({})).toBeUndefined();
    expect(modelFromEnv({ ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-opus-5-5" })?.modelId).toBe("claude-opus-5-5");
  });
});
