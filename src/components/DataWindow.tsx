import { FONTS } from "@/theme";
import { useTheme } from "@/hooks/useTheme";

// One per dataset — drives the freshness wording + the timezone "today" is read
// in (RU MoD reconciles to Moscow time; everything else to Kyiv).
export type DataWindowMode = "sbs" | "gsua" | "ru-losses" | "ru-mod" | "ru-air-attacks" | "mediazona";

const TZ: Record<DataWindowMode, string> = {
  sbs: "Europe/Kyiv",
  gsua: "Europe/Kyiv",
  "ru-losses": "Europe/Kyiv",
  "ru-air-attacks": "Europe/Kyiv",
  "ru-mod": "Europe/Moscow",
  mediazona: "Europe/Kyiv",
};

function todayInTz(tz: string): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: tz });
}

// Calendar days from the latest data day to "now" (both YYYY-MM-DD, parsed as UTC
// midnight so DST can't skew the difference).
function daysBehind(maxDate: string, today: string): number {
  return Math.round((Date.parse(today) - Date.parse(maxDate)) / 86_400_000);
}

const behindNote = (n: number) => `${n} day${n === 1 ? "" : "s"} behind`;

// Is the most recent day final, still settling, or actually stale? The cadence
// differs per source, so the threshold for "behind" does too.
// `latestSnapshotAt` (GSUA only) is the newest snapshot timestamp on the latest
// day, used to tell a still-accumulating "today" from a finished one.
function freshness(
  mode: DataWindowMode,
  maxDate: string,
  today: string,
  latestSnapshotAt?: string | null
): { note: string; stale: boolean } {
  const behind = daysBehind(maxDate, today);
  switch (mode) {
    case "sbs":
      // Real hourly data → the day isn't complete until it's over.
      if (behind <= 0) return { note: "today still settling — hourly values arrive until the day is over", stale: false };
      if (behind === 1) return { note: "up to date", stale: false };
      return { note: behindNote(behind), stale: true };
    case "gsua": {
      // GS reports run cumulative through the day; the day is done once the 22:00
      // post lands (the next-morning 08:00 summary also sorts after that), so a
      // "today" with a ≥22:00 snapshot already counts as up to date.
      if (behind >= 2) return { note: behindNote(behind), stale: true };
      const complete = !!latestSnapshotAt && latestSnapshotAt >= `${maxDate}T22:00:00`;
      if (behind === 1 || complete) return { note: "up to date", stale: false };
      return { note: "today is partial — updates through the 22:00 General Staff post", stale: false };
    }
    case "ru-mod":
      // MoD posts ~twice a day; a day is only complete once the next day's report lands.
      if (behind <= 0) return { note: "today is partial — RU MoD posts ~twice a day, complete only the next day", stale: false };
      if (behind === 1) return { note: "up to date", stale: false };
      return { note: behindNote(behind), stale: true };
    case "ru-losses":
      // Each day's losses are published the next morning, so the newest day is normally yesterday.
      if (behind <= 1) return { note: "up to date — the latest day is reported the next morning", stale: false };
      return { note: behindNote(behind - 1), stale: true };
    case "ru-air-attacks":
      // The real Air Force data exists daily; this Kaggle mirror just re-publishes
      // ~weekly. Always show the explicit lag, but only flag it once it exceeds
      // the normal weekly refresh window.
      if (behind <= 0) return { note: "up to date", stale: false };
      return { note: `${behindNote(behind)} — source refreshes ~weekly`, stale: behind > 8 };
    case "mediazona":
      // Weekly series. Recent weeks are incomplete BY DESIGN — named deaths are
      // bucketed by date of death and take weeks/months to identify — so a lag
      // here isn't staleness. Never flag; just explain.
      return { note: "recent weeks are incomplete — named deaths are identified with a lag of weeks to months", stale: false };
  }
}

/**
 * One-line "Data <first> – <last> · <freshness>" note for a dataset's description
 * block, so you can see the covered window and whether it's current at a glance.
 * Renders nothing until the window is known.
 */
export function DataWindow({
  minDate,
  maxDate,
  mode,
  latestSnapshotAt,
}: {
  minDate: string | null;
  maxDate: string | null;
  mode: DataWindowMode;
  latestSnapshotAt?: string | null; // GSUA only: newest snapshot on the latest day
}) {
  const { theme: t } = useTheme();
  if (!minDate || !maxDate) return null;
  const { note, stale } = freshness(mode, maxDate, todayInTz(TZ[mode]), latestSnapshotAt);
  return (
    <div style={{ fontFamily: FONTS.mono, fontSize: 11, color: t.textMuted, marginTop: 3 }}>
      Data Availability: {minDate} – {maxDate} ·{" "}
      <span style={{ color: stale ? t.textImportant : t.textMuted, fontWeight: stale ? 700 : 400 }}>{note}</span>
    </div>
  );
}
