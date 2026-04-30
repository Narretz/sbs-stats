/// <reference types="@cloudflare/workers-types" />

export interface Env {
  GH_TOKEN: string;
  GH_OWNER: string;
  GH_REPO: string;
  GH_WORKFLOW: string;
  GH_REF: string;
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await dispatch(env);
  },

  async fetch(_req: Request, env: Env): Promise<Response> {
    try {
      await dispatch(env);
      return new Response("dispatched\n");
    } catch (err) {
      return new Response(String(err), { status: 500 });
    }
  },
};

async function dispatch(env: Env): Promise<void> {
  const url = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "sbs-stats-cron",
    },
    body: JSON.stringify({ ref: env.GH_REF }),
  });
  if (!res.ok) {
    throw new Error(`GitHub dispatch failed: ${res.status} ${await res.text()}`);
  }
}
