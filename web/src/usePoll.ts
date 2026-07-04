import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Poll an async producer on an interval (the registry is polling-only, §8.5).
 * Keeps the last good value on transient errors; `deps` restart the loop.
 */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const v = await fnRef.current();
        if (alive) {
          setData(v);
          setError(null);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
      if (alive) timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, nonce, ...deps]);

  return { data, error, refresh };
}
