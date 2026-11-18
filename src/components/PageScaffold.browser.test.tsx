import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import "@/styles/theme.css";
import { PageScaffold } from "@/components/PageScaffold";
import type { LoadState } from "@/types";

// The loading screen names what the page is waiting for: the site's DB while
// it loads, then the page's own queries over it.

function draw(loadState: LoadState, hasData: boolean) {
  return render(
    <PageScaffold title="T" description="d" loadState={loadState} error={null} hasData={hasData}
      loadingMessage="Loading T database …" gridChildren={<div className="chart-card">chart</div>} />,
  );
}

describe("PageScaffold's loading screen", () => {
  it("names the DB while it loads", async () => {
    const r = await draw("loading", false);
    await expect.element(r.getByText("Loading T database …")).toBeVisible();
  });

  it("names the page's queries once the DB has loaded and its rows haven't arrived", async () => {
    const r = await draw("ready", false);
    await expect.element(r.getByText("Preparing data …")).toBeVisible();
    expect(r.container.textContent).not.toContain("Loading T database");
  });

  it("gives way to the charts once they have", async () => {
    const r = await draw("ready", true);
    await expect.element(r.getByText("chart")).toBeVisible();
    expect(r.container.textContent).not.toContain("Preparing data");
  });
});
