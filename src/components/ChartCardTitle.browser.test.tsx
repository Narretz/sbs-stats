import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "@/styles/theme.css";
import { ChartCardTitle } from "@/components/ChartCardTitle";

// A chart card's title: a link to its own card, with a "#" that shows on
// hover. Where the anchors lead, and the page scrolling to them, is
// e2e/chart-anchors.spec.ts.

describe("ChartCardTitle", () => {
  // It has to be CSS generated content. As a real <span> it joined the
  // heading's textContent, so titles read "Mortars #" and every
  // `getByText(title, { exact: true })` lookup broke — which is exactly how
  // this was caught (4 failures in undisclosed-counts.spec.ts).
  it("keeps the '#' affordance out of the title's text, shown on hover", async () => {
    const { container } = await render(<ChartCardTitle title="Mortars" anchor="mortars" />);
    const link = container.querySelector<HTMLAnchorElement>(".chart-anchor")!;
    expect(link.textContent).toBe("Mortars");
    expect(link.getAttribute("href")).toBe("#mortars");
    await expect.element(page.getByText("Mortars", { exact: true })).toBeVisible();

    const after = () => getComputedStyle(link, "::after");
    expect(after().content).toBe('" #"');
    expect(after().opacity).toBe("0");
    await userEvent.hover(link);
    await expect.poll(() => after().opacity).toBe("0.55");
  });

  it("is plain text without an anchor", async () => {
    const { container } = await render(<ChartCardTitle title="Mortars" />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("Mortars");
  });
});
