import { lazy, type ComponentType, type LazyExoticComponent } from "react";

// A page loaded on first render rather than with the app: each page, with the
// charts and helpers only it uses, becomes its own chunk. The pages are named
// exports, and React.lazy wants a default one — this bridges the two.
// Rendered under the <Suspense> in App.tsx's PageShell.
export function lazyPage<P extends object, K extends string>(
  load: () => Promise<Record<K, ComponentType<P>>>,
  name: K,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}
