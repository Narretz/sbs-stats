// The primary sources behind a date — the posts its figures were read from —
// as the pinned sheet's links (TooltipDescriptor.sources). Pure: each hook
// queries its rows, these turn them into labelled links.
import { Temporal } from "temporal-polyfill";
import type { SheetSource } from "@/components/TooltipTable";
import { interimReportTime } from "@/utils/gsuaInterim";

// "2026-10-12 21:34 Moscow": when a post went up, in the time its source reports
// on — the date a reader would look for it under.
export function formatPostedAt(iso: string, timeZone: string, zoneLabel: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const s = d.toLocaleString("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  return `${s} ${zoneLabel}`;
}

// "2026-10-09 20:00 – 10-11 20:00 Moscow": the span a report covers, both ends
// in its source's zone; the end drops what it shares with the start.
export function formatWindow(startIso: string, endIso: string, timeZone: string, zoneLabel: string): string {
  const start = formatPostedAt(startIso, timeZone, "").trim();
  const end = formatPostedAt(endIso, timeZone, "").trim();
  if (start.slice(0, 10) === end.slice(0, 10)) return `${start} – ${end.slice(11)} ${zoneLabel}`;
  if (start.slice(0, 4) === end.slice(0, 4)) return `${start} – ${end.slice(5)} ${zoneLabel}`;
  return `${start} – ${end} ${zoneLabel}`;
}

// A report split across several posts (a channel's message-length limit):
// one link per part, the stored URL's channel with each part's id. A single
// post is its own URL.
export function partLinks(url: string, partIds: string | null | undefined): string[] {
  const ids = (partIds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length < 2) return [url];
  const base = url.replace(/\/\d+$/, "");
  return ids.map((id) => `${base}/${id}`);
}

// One labelled link per part: "…, part 1 of 2".
export function linksFor(url: string, partIds: string | null | undefined, label: string, linkText?: string): SheetSource[] {
  const urls = partLinks(url, partIds);
  const part = (i: number) => (urls.length > 1 ? `part ${i + 1} of ${urls.length}` : "");
  return urls.map((href, i) => ({ href, linkText, label: [label, part(i)].filter(Boolean).join(", ") }));
}

// ── CIT ─────────────────────────────────────────────────────────────────────

export interface CitReportSource {
  report_date: string;   // the window's END date
  window_days: number;
  window_start: string | null; // ISO, UTC
  window_end: string | null;
  url: string;
  part_ids: string | null;
  posted_at: string | null;
}

// Each day a report covers gets its links — both days of a 48-hour weekend
// report, as the charts draw it across both.
export function citSourcesByDate(reports: readonly CitReportSource[]): Map<string, SheetSource[]> {
  const out = new Map<string, SheetSource[]>();
  for (const r of reports) {
    const span = r.window_days > 0 ? r.window_days : 1;
    // Linked as when it went up, then the window it covers — a weekend
    // report's 48 hours show in it.
    const label = r.window_start && r.window_end
      ? formatWindow(r.window_start, r.window_end, "Europe/Moscow", "Moscow")
      : span > 1 ? `${span * 24}-hour report` : "";
    const links = linksFor(r.url, r.part_ids, label, r.posted_at ? formatPostedAt(r.posted_at, "Europe/Moscow", "Moscow") : undefined);
    const end = Temporal.PlainDate.from(r.report_date);
    for (let back = span - 1; back >= 0; back--) {
      const date = end.subtract({ days: back }).toString();
      out.set(date, [...(out.get(date) ?? []), ...links]);
    }
  }
  return out;
}

// ── GSUA ────────────────────────────────────────────────────────────────────

export interface GsuaPostSource {
  date: string;
  source: string;            // telegram | facebook | …
  source_id: string | number;
  snapshot_at: string | null; // "станом на" time, Kyiv, YYYY-MM-DDTHH:MM…
  message_date: string | null; // when it was posted, ISO UTC
  url: string;
}

// A day's General Staff posts, the one its figures come from first — the
// canonical pick of canonicalDailySql: telegram before other sources, then
// the latest snapshot (the next morning's wrap-up over the 22:00 interim).
// A report split across posts (same source and snapshot) is numbered by part.
// Another platform's copy (the legacy Facebook fallback's rows, May 2026, and
// the 2023–24 backfill from Facebook and kmu.gov.ua) is listed only for a day
// with no Telegram post: otherwise it is a duplicate nothing reads.
const GSUA_PLATFORMS: Record<string, string> = { facebook: "Facebook", kmu: "kmu.gov.ua" };

export function gsuaSourcesByDate(posts: readonly GsuaPostSource[]): Map<string, SheetSource[]> {
  const byDate = new Map<string, GsuaPostSource[]>();
  for (const p of posts) byDate.set(p.date, [...(byDate.get(p.date) ?? []), p]);
  const out = new Map<string, SheetSource[]>();
  for (const [date, all] of byDate) {
    const list = all.some((p) => p.source === "telegram") ? all.filter((p) => p.source === "telegram") : all;
    const sourceRank = (s: string) => (s === "telegram" ? 0 : 1);
    list.sort((a, b) =>
      sourceRank(a.source) - sourceRank(b.source) || a.source.localeCompare(b.source)
      || (b.snapshot_at ?? "").localeCompare(a.snapshot_at ?? "")
      || Number(a.source_id) - Number(b.source_id));
    // Parts: posts sharing source and snapshot.
    const partKey = (p: GsuaPostSource) => `${p.source}|${p.snapshot_at ?? ""}`;
    const partsOf = new Map<string, number>();
    for (const p of list) partsOf.set(partKey(p), (partsOf.get(partKey(p)) ?? 0) + 1);
    const seen = new Map<string, number>();
    // Linked as when it went up, then "as of 2026-10-13 08:00 Kyiv" — a
    // non-Telegram copy names its platform first, an interim report says so last.
    out.set(date, list.map((p) => {
      const n = partsOf.get(partKey(p))!;
      const i = (seen.get(partKey(p)) ?? 0) + 1;
      seen.set(partKey(p), i);
      const parts = [
        p.source === "telegram" ? "" : GSUA_PLATFORMS[p.source] ?? p.source,
        p.snapshot_at ? `as of ${p.snapshot_at.slice(0, 10)} ${p.snapshot_at.slice(11, 16)} Kyiv` : "",
        n > 1 ? `part ${i} of ${n}` : "",
      ].filter(Boolean);
      const label = `${parts.join(", ")}${interimReportTime(date, p.snapshot_at) ? " (interim)" : ""}`;
      const linkText = p.message_date ? formatPostedAt(p.message_date, "Europe/Kyiv", "Kyiv") : undefined;
      return { href: p.url, linkText, label };
    }));
  }
  return out;
}

// ── RU MoD air defense ──────────────────────────────────────────────────────

export interface RuModReportSource {
  report_date: string;
  post_id: number | string;
  window_kind: string;         // night | day
  window_start: string | null; // "2026-09-29T20:00+03:00", MSK
  window_end: string | null;
  drones: number | null;
  unit: string | null;         // uav | air_target
  posted_at: string | null;    // ISO, UTC
}

const RU_MOD_CHANNEL = "https://t.me/mod_russia";

// A date's MoD reports in window order, each its post on the channel (the id
// the scraper reads it under) and what it reported, so the night / day split
// on the chart can be traced to the posts that make it up — linked as when it
// went up, then "overnight, 2026-09-29 20:00 – 09-30 08:00 Moscow, 384 UAVs".
export function ruModSourcesByDate(reports: readonly RuModReportSource[]): Map<string, SheetSource[]> {
  const out = new Map<string, SheetSource[]>();
  const sorted = [...reports].sort((a, b) => (a.window_end ?? "").localeCompare(b.window_end ?? ""));
  for (const r of sorted) {
    const window = r.window_start && r.window_end ? formatWindow(r.window_start, r.window_end, "Europe/Moscow", "Moscow") : "";
    const label = [
      r.window_kind === "night" ? "overnight" : "daytime",
      window,
      r.drones != null ? `${r.drones.toLocaleString("en-US")} ${r.unit === "air_target" ? "air targets" : "UAVs"}` : "",
    ].filter(Boolean).join(", ");
    const linkText = r.posted_at ? formatPostedAt(r.posted_at, "Europe/Moscow", "Moscow") : undefined;
    out.set(r.report_date, [...(out.get(r.report_date) ?? []), { href: `${RU_MOD_CHANNEL}/${r.post_id}`, linkText, label }]);
  }
  return out;
}

// ── Monthly recaps (Rubikon, SBU Alfa) ───────────────────────────────────────

// One recap per month, keyed "YYYY-MM", linked as when it went up —
// "2026-10-03 09:00 Moscow", or "2026-10-10" where the source gives only a date.
export function monthlySourcesByPeriod(
  reports: readonly { period: string; url: string; postedAt?: string | null; publishedOn?: string | null }[],
  timeZone: string,
  zoneLabel: string,
): Map<string, SheetSource[]> {
  const out = new Map<string, SheetSource[]>();
  for (const r of reports) {
    const linkText = r.postedAt ? formatPostedAt(r.postedAt, timeZone, zoneLabel) : r.publishedOn ?? undefined;
    const key = r.period.slice(0, 7);
    out.set(key, [...(out.get(key) ?? []), { href: r.url, linkText, label: "" }]);
  }
  return out;
}

// ── RU air attacks (piterfm / Kaggle) ───────────────────────────────────────
// Each attack row names the post it was read from: a Facebook path of the UA
// Air Force or one of its regional commands (a handful are full URLs). There
// is no post time, so the link reads as the account; what follows is the span
// and totals of that post's attacks on the day.

export interface AirAttackRow {
  date: string;              // attack_date
  category: string;
  model: string;
  source: string | null;
  time_start: string | null; // "2026-10-09 18:00" or "2026-10-09", Kyiv
  time_end: string | null;
  launched: number | null;
  destroyed: number | null;
  hidden: number;            // 1 when the figures were withheld
}

const AIR_ACCOUNTS: Record<string, string> = {
  kpszsu: "Air Force",
  pvkpivden: "Air Command South",
  pvkshid: "Air Command East",
  pvkzahid: "Air Command West",
  pvkcenter: "Air Command Centre",
  "generalstaff.ua": "General Staff",
  cincafu: "Commander-in-Chief",
};

export function airSourceUrl(source: string): string {
  return /^https?:\/\//.test(source) ? source : `https://www.facebook.com/${source.replace(/^\/+/, "")}`;
}

function airAccount(source: string): string {
  const path = /^https?:\/\//.test(source) ? source.replace(/^https?:\/\/[^/]+\//, "") : source;
  const slug = path.split("/")[0] ?? "";
  return AIR_ACCOUNTS[slug.toLowerCase()] ?? (slug || "Facebook");
}

// "2026-10-09 18:00 – 10-10 09:00 Kyiv"; a date-only span is just its date(s).
function airSpan(start: string, end: string): string {
  const hasTime = (s: string) => s.length > 10;
  if (!hasTime(start) && !hasTime(end)) return start === end ? start : `${start} – ${end.slice(5)}`;
  const endShown = end.slice(0, 10) === start.slice(0, 10) ? end.slice(11) : end.slice(5);
  return `${start} – ${endShown} Kyiv`;
}

// The posts behind a chart's figures on each date: `keep` picks the rows the
// chart counts (a category, a model, or all of them).
export function airAttackSourcesByDate(
  rows: readonly AirAttackRow[],
  keep: (r: AirAttackRow) => boolean = () => true,
): Map<string, SheetSource[]> {
  const groups = new Map<string, { date: string; source: string; start: string; end: string; launched: number; destroyed: number; withheld: boolean }>();
  for (const r of rows) {
    if (!r.source || !keep(r)) continue;
    const k = `${r.date}|${r.source}`;
    const start = r.time_start ?? r.date, end = r.time_end ?? r.date;
    const g = groups.get(k) ?? { date: r.date, source: r.source, start, end, launched: 0, destroyed: 0, withheld: false };
    if (start < g.start) g.start = start;
    if (end > g.end) g.end = end;
    if (r.hidden) g.withheld = true;
    else { g.launched += r.launched ?? 0; g.destroyed += r.destroyed ?? 0; }
    groups.set(k, g);
  }
  const out = new Map<string, SheetSource[]>();
  for (const g of [...groups.values()].sort((a, b) => a.start.localeCompare(b.start) || a.source.localeCompare(b.source))) {
    const figures = `${g.launched.toLocaleString("en-US")} launched, ${g.destroyed.toLocaleString("en-US")} intercepted`;
    const label = [airSpan(g.start, g.end), g.launched || !g.withheld ? figures : "", g.withheld ? "some figures withheld" : ""]
      .filter(Boolean).join(", ");
    out.set(g.date, [...(out.get(g.date) ?? []), { href: airSourceUrl(g.source), linkText: airAccount(g.source), label }]);
  }
  return out;
}
