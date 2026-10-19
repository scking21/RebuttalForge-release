import { caseIdFromHash, createSingleFlight } from "./interaction";
export { caseHref } from "./interaction";
import { useCallback, useEffect, useRef, useState } from "react";

export interface Resource<T> {
  data: T | undefined;
  error: string | undefined;
  updatedAt: Date | undefined;
  loading: boolean;
  reload: () => void;
  replace: (data: T) => void;
}

interface Slot<T> {
  key: string;
  data?: T;
  error?: string;
  at?: Date;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// `key` identifies the thing being loaded; a null key means nothing to load.
// Data from a different key is never shown. Failed polls keep the last good data and surface the error.
export function useResource<T>(load: () => Promise<T>, key: string | null, pollMs?: number): Resource<T> {
  const [slot, setSlot] = useState<Slot<T>>({ key: "" });
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);

  const fetchNow = useCallback(() => {
    if (key === null) return;
    const mine = ++seq.current;
    loadRef.current().then(
      (data) => {
        if (mine === seq.current) setSlot({ key, data, at: new Date() });
      },
      (e: unknown) => {
        if (mine === seq.current) setSlot((s) => (s.key === key ? { ...s, error: errorMessage(e) } : { key, error: errorMessage(e) }));
      },
    );
  }, [key]);

  useEffect(() => {
    fetchNow();
    const timer = pollMs && key !== null ? setInterval(fetchNow, pollMs) : undefined;
    return () => {
      seq.current++; // Ignore results after navigation or unmount.
      if (timer !== undefined) clearInterval(timer);
    };
  }, [fetchNow, pollMs, key]);

  const current = key !== null && slot.key === key ? slot : undefined;
  const replace = useCallback(
    (data: T) => {
      seq.current++;
      if (key !== null) setSlot({ key, data, at: new Date() });
    },
    [key],
  );

  return {
    data: current?.data,
    error: current?.error,
    updatedAt: current?.at,
    loading: key !== null && current === undefined,
    reload: fetchNow,
    replace,
  };
}

export interface ActionState {
  pending: string | null;
  error: string | undefined;
  run: <R>(name: string, fn: () => Promise<R>) => Promise<R | undefined>;
}

export function useAction(): ActionState {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const flight = useRef(createSingleFlight());
  const run = useCallback(async <R,>(name: string, fn: () => Promise<R>) => flight.current(async () => {
    setPending(name);
    setError(undefined);
    try {
      return await fn();
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setPending(null);
    }
  }), []);
  return { pending, error, run };
}

function readHash(): string | null {
  return caseIdFromHash(window.location.hash);
}

export function useSelectedCaseId(): string | null {
  const [id, setId] = useState(readHash);
  useEffect(() => {
    const onChange = () => setId(readHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return id;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
