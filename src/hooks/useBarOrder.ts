import { useState } from "react";
import { parseBarOrder, type BarOrder } from "@/utils/barOrder";

// A page's bar order (utils/barOrder), kept in the URL as `order=` so a ranked
// view links like any other. "date" is the default and leaves no param.
export function useBarOrder(): [BarOrder, (o: BarOrder) => void] {
  const [order, setOrderState] = useState<BarOrder>(() =>
    parseBarOrder(new URLSearchParams(window.location.search).get("order")));
  const setOrder = (o: BarOrder) => {
    setOrderState(o);
    const p = new URLSearchParams(window.location.search);
    if (o === "date") p.delete("order");
    else p.set("order", o);
    window.history.replaceState(null, "", `${window.location.pathname}?${p.toString()}${window.location.hash}`);
  };
  return [order, setOrder];
}
