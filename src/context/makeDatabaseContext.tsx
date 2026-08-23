import { createContext, useContext, type ReactNode } from "react";

// Generic factory for a dataset's React context. Every dataset exposes one
// `useDatabaseX` hook and wants the same wrapper around it: a Provider that
// runs the hook once and a consumer hook that reads the value (throwing if used
// outside the provider). Rather than hand-write a near-identical provider +
// context module per dataset, each is instantiated from this factory in
// src/context/databases.ts. `label` names the dataset in the misuse error.
export function makeDatabaseContext<T>(useDbHook: () => T, label: string) {
  const Ctx = createContext<T | null>(null);

  function Provider({ children }: { children: ReactNode }) {
    const value = useDbHook();
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
  }

  function useDbContext(): T {
    const ctx = useContext(Ctx);
    if (!ctx) throw new Error(`${label} database context used outside its provider`);
    return ctx;
  }

  return { Provider, useDbContext };
}
