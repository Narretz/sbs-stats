import type { ReactNode } from "react";

// A monthly tooltip header: the month, and pushed to the trailing edge in small
// type what the figure covers — "18 of 31 days" (utils/monthProjection).
// width:100% because recharts wraps the
// tooltip in a shrink-to-fit container, where space-between has nothing to
// distribute.
export function monthHeader(label: ReactNode, basis: string | undefined): ReactNode {
  if (!basis) return label;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", width: "100%" }}>
      <span>{label}</span>
      <span style={{ fontSize: 10, marginLeft: 15 }}>{basis}</span>
    </div>
  );
}
