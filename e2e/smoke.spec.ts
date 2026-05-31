import { expect, test } from "@playwright/test";

test.describe("smoke", () => {
  test("root page renders", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByAltText("Chro")).toBeVisible();
    await page.waitForLoadState("networkidle");
  });
});
