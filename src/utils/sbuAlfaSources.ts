// SBU Alfa publishes each monthly recap twice — as a press release on
// ssu.gov.ua and as a post on its Telegram channel — and the DB can hold both
// (scripts/sbu_alfa: telegram.py finds posts, ingest.py takes either). They
// carry the same counters, so a month must be read from ONE of them: two would
// double every chart and the enumerated-targets sum.
//
// The press release wins where there is one — it is the canonical text, and
// the site's own page for the recap — and the post stands in where there
// isn't. Between two posts (a recap reposted), the earlier is the original.

const isChannelPost = (url: string) => /^https?:\/\/t\.me\//.test(url);

interface SourcedRow {
  period: string;
  url: string;
  published_at: string | null;
}

/** The url each period is read from. */
export function chosenSourceByPeriod(rows: readonly SourcedRow[]): Map<string, string> {
  const best = new Map<string, SourcedRow>();
  for (const r of rows) {
    const cur = best.get(r.period);
    if (!cur || preferred(r, cur)) best.set(r.period, r);
  }
  return new Map([...best].map(([period, r]) => [period, r.url]));
}

function preferred(a: SourcedRow, b: SourcedRow): boolean {
  const postA = isChannelPost(a.url), postB = isChannelPost(b.url);
  if (postA !== postB) return !postA;
  const pa = a.published_at ?? "￿", pb = b.published_at ?? "￿";
  if (pa !== pb) return pa < pb;
  return a.url < b.url;
}

/** `rows` with each period's rows from its chosen source only. */
export function oneSourcePerPeriod<T extends SourcedRow>(rows: readonly T[]): T[] {
  const chosen = chosenSourceByPeriod(rows);
  return rows.filter((r) => chosen.get(r.period) === r.url);
}
