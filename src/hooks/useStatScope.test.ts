import { describe, expect, it } from "vitest";
import { readStatScope } from "@/hooks/useStatScope";

describe("readStatScope", () => {
  it("is the window unless the URL says all", () => {
    expect(readStatScope("")).toBe("window");
    expect(readStatScope("?base=all")).toBe("all");
    expect(readStatScope("?base=window")).toBe("window");
    expect(readStatScope("?base=ALL")).toBe("window");
  });

  it("reads the home page's older scope= spelling, not the compare page's scope=1", () => {
    expect(readStatScope("?scope=all")).toBe("all");
    expect(readStatScope("?scope=1")).toBe("window");
    expect(readStatScope("?base=window&scope=all")).toBe("window");
  });
});
