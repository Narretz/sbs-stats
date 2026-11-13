/// <reference types="@cloudflare/workers-types" />

export interface Env {
  GH_TOKEN: string;
  GH_OWNER: string;
  GH_REPO: string;
  GH_REF: string;
}

export type Dispatch = { workflow: string; inputs?: Record<string, string | boolean> };

// One cron trigger (wrangler.toml) drives everything; which workflows a tick
// dispatches is decided here from the tick's scheduled time. Cloudflare crons
// are UTC-only, so the daily runs are matched in Kyiv local time instead —
// that way they follow DST, like the `timezone: Europe/Kyiv` GitHub schedules.
//
// `scheduledTime` is the minute the tick was due, not when the code started,
// so comparing it to the exact minute is safe.
export function dispatchesFor(scheduledTime: number): Dispatch[] {
  const { hour, minute } = kyivTime(scheduledTime);
  const jobs: Dispatch[] = [{ workflow: "update-db.yml" }]; // SBS: every tick

  if (minute === 10 && (hour === 9 || hour === 23)) {
    jobs.push({ workflow: "update-telegram-web-dbs.yml" });
  }
  if (minute === 10 && hour === 9) {
    jobs.push({ workflow: "update-ru-losses-db.yml" });
  }
  // Front-line weather, hourly: the SBS hourly page's strip shows today's
  // hours as they settle and the forecast for the rest of the day, so a late
  // or skipped GitHub cron run shows as a stale "today". Kyiv's offset is
  // whole hours, so :25 Kyiv is :25 UTC.
  if (minute === 25) {
    jobs.push({ workflow: "update-weather-db.yml" });
  }
  return jobs;
}

const KYIV = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Kyiv",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function kyivTime(ms: number): { hour: number; minute: number } {
  const parts = KYIV.formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { hour: get("hour"), minute: get("minute") };
}

export default {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    // allSettled: one workflow's failed dispatch must not drop the others.
    const jobs = dispatchesFor(event.scheduledTime);
    const results = await Promise.allSettled(jobs.map((j) => dispatch(env, j)));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length) {
      throw new Error(failed.map((r) => String(r.reason)).join("\n"));
    }
  },

  // Manual poke: dispatches the SBS workflow only.
  async fetch(_req: Request, env: Env): Promise<Response> {
    try {
      await dispatch(env, { workflow: "update-db.yml" });
      return new Response("dispatched\n");
    } catch (err) {
      return new Response(String(err), { status: 500 });
    }
  },
};

async function dispatch(env: Env, { workflow, inputs }: Dispatch): Promise<void> {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${workflow}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "sbs-stats-cron",
    },
    body: JSON.stringify({ ref: env.GH_REF, ...(inputs && { inputs }) }),
  });
  if (!res.ok) {
    throw new Error(`GitHub dispatch of ${workflow} failed: ${res.status} ${await res.text()}`);
  }
}
