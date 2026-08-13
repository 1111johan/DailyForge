import { describe, expect, it } from "vitest";
import { PRODUCTS, topicsForProduct } from "@/lib/catalog";

describe("content catalog", () => {
  it("keeps CET-4 and CET-6 products and topics separate", () => {
    expect(PRODUCTS.map((product) => product.id)).toEqual(["cet4", "cet6"]);
    expect(topicsForProduct("cet4").length).toBeGreaterThanOrEqual(10);
    expect(topicsForProduct("cet6").length).toBeGreaterThanOrEqual(10);
    expect(
      topicsForProduct("cet4").every((topic) => topic.product_id === "cet4"),
    ).toBe(true);
    expect(
      topicsForProduct("cet6").every((topic) => topic.product_id === "cet6"),
    ).toBe(true);
  });
});
