import { useCallback, useEffect, useRef, useState } from "react";
import type { LoadState } from "@/types";

// A module-scoped cache cell holding the in-flight (or resolved) load
// promise and the timestamp at which it was started. The timestamp
// survives hook unmount/remount, so a hook that re-mounts after the
// view was switched away (and thus its auto-refresh interval was
// cleared) can detect that its cached resource is stale and force a
// refresh on remount.
export type ResourceCache<T> = {
  promise: Promise<T> | null;
  createdAt: number | null;
};

export function makeResourceCache<T>(): ResourceCache<T> {
  return { promise: null, createdAt: null };
}

/**
 * Shared lifecycle for the dataset hooks. Each dataset (SBS / GSUA / RU
 * MoD / RU Losses / RU air-attacks) loads exactly one expensive
 * resource (a sql.js Database or a sql.js-httpvfs WorkerHttpvfs) and
 * wants identical refresh behavior on top of it:
 *
 *   - Cache the resource at module scope so navigation within a view
 *     doesn't re-fetch the DB.
 *   - On mount, if the cached resource is older than the dataset's
 *     refresh interval (e.g. user switched away yesterday and came
 *     back today), force a refresh instead of returning the stale
 *     cache.
 *   - Auto-refresh every `refreshIntervalMs`, skipping ticks while the
 *     tab is hidden.
 *   - On visibility restore, refresh immediately if the resource is
 *     stale.
 *   - Expose a manual refresh.
 *
 * Callers must declare both `cache` and `load` at module scope so
 * their identity is stable across renders; the hook's useCallback
 * deps include them.
 */
export function useRefreshableResource<T>({
  cache,
  load,
  refreshIntervalMs,
}: {
  cache: ResourceCache<T>;
  load: () => Promise<T>;
  refreshIntervalMs: number;
}): {
  resource: T | null;
  loadState: LoadState;
  error: string | null;
  lastRefreshed: Date | null;
  refresh: () => void;
  refreshCount: number;
  refreshIntervalMs: number;
} {
  const [resource, setResource] = useState<T | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const lastRefreshedRef = useRef<Date | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);

  const doLoad = useCallback(() => {
    setLoadState("loading");
    if (!cache.promise) {
      cache.promise = load();
      cache.createdAt = Date.now();
    }
    cache.promise
      .then((r) => {
        setResource(r);
        setLoadState("ready");
        const now = new Date();
        setLastRefreshed(now);
        lastRefreshedRef.current = now;
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoadState("error");
        cache.promise = null;
        cache.createdAt = null;
      });
  }, [cache, load]);

  const doRefresh = useCallback(() => {
    cache.promise = null;
    cache.createdAt = null;
    setResource(null);
    setRefreshCount((c) => c + 1);
    doLoad();
  }, [cache, doLoad]);

  // Initial load. If the cached resource is older than the refresh
  // interval (view re-mounted after being away), force a refresh.
  useEffect(() => {
    if (cache.createdAt !== null && Date.now() - cache.createdAt >= refreshIntervalMs) {
      doRefresh();
    } else {
      doLoad();
    }
  }, [cache, refreshIntervalMs, doLoad, doRefresh]);

  // Auto-refresh while visible.
  useEffect(() => {
    const interval = setInterval(() => {
      if (document.hidden) return;
      doRefresh();
    }, refreshIntervalMs);
    return () => clearInterval(interval);
  }, [doRefresh, refreshIntervalMs]);

  // On visibility restore, refresh immediately if stale.
  useEffect(() => {
    const handle = () => {
      if (document.hidden) return;
      const age = lastRefreshedRef.current ? Date.now() - lastRefreshedRef.current.getTime() : Infinity;
      if (age >= refreshIntervalMs) doRefresh();
    };
    document.addEventListener("visibilitychange", handle);
    return () => document.removeEventListener("visibilitychange", handle);
  }, [doRefresh, refreshIntervalMs]);

  const refresh = useCallback(() => { doRefresh(); }, [doRefresh]);

  return { resource, loadState, error, lastRefreshed, refresh, refreshCount, refreshIntervalMs };
}
