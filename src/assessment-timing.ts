import { performance } from "node:perf_hooks";

type Phase = "evidenceRetrievalMs" | "modelAssessmentMs";
export type AssessmentOutcome = "actionable" | "hold" | "resolved" | "error";

// Only durations/flags/outcome leave this helper. Never give it payloads, keys,
// source records, exception text or provider responses.
export class AssessmentTimer {
  private readonly started: number;
  private readonly starts: Partial<Record<Phase, number>> = {};
  private readonly durations: Record<Phase, number> = { evidenceRetrievalMs: 0, modelAssessmentMs: 0 };
  private modelInvoked = false;

  constructor(private readonly monotonicNow: () => number = () => performance.now()) {
    this.started = monotonicNow();
  }

  begin(phase: Phase): void {
    this.starts[phase] = this.monotonicNow();
    if (phase === "modelAssessmentMs") this.modelInvoked = true;
  }

  end(phase: Phase): void {
    const start = this.starts[phase];
    if (start === undefined) return;
    this.durations[phase] += Math.max(0, this.monotonicNow() - start);
    delete this.starts[phase];
  }

  finish(outcome: AssessmentOutcome, prefetchedDispute: boolean) {
    const ms = (value: number) => Math.round(value * 1000) / 1000;
    return {
      clock: "monotonic", scope: "assessment_work",
      evidenceRetrievalMs: ms(this.durations.evidenceRetrievalMs),
      modelAssessmentMs: ms(this.durations.modelAssessmentMs),
      totalAssessmentMs: ms(Math.max(0, this.monotonicNow() - this.started)),
      modelInvoked: this.modelInvoked, prefetchedDispute, outcome,
    };
  }
}
