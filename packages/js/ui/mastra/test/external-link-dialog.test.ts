import { describe, expect, test } from "bun:test";
import { resolveLinkPresentation } from "../src/react/_external-link-dialog.tsx";

const baseUrl = "https://local-demo.apps.dbx.tools/chat/thread-1";

describe("resolveLinkPresentation", () => {
  test("shows same-origin absolute links as paths while retaining the full URL", () => {
    expect(
      resolveLinkPresentation(
        "https://local-demo.apps.dbx.tools/sandbox/machine-1/terminal?mode=full#session",
        baseUrl,
      ),
    ).toEqual({
      displayUrl: "/sandbox/machine-1/terminal?mode=full#session",
      absoluteUrl:
        "https://local-demo.apps.dbx.tools/sandbox/machine-1/terminal?mode=full#session",
    });
  });

  test("resolves relative links to full clipboard URLs", () => {
    expect(resolveLinkPresentation("/settings/profile?tab=auth", baseUrl)).toEqual({
      displayUrl: "/settings/profile?tab=auth",
      absoluteUrl: "https://local-demo.apps.dbx.tools/settings/profile?tab=auth",
    });
  });

  test("keeps external origins fully visible", () => {
    expect(resolveLinkPresentation("https://example.com/docs?q=1", baseUrl)).toEqual({
      displayUrl: "https://example.com/docs?q=1",
      absoluteUrl: "https://example.com/docs?q=1",
    });
  });

  test("does not shorten non-web schemes", () => {
    expect(resolveLinkPresentation("mailto:user@example.com", baseUrl)).toEqual({
      displayUrl: "mailto:user@example.com",
      absoluteUrl: "mailto:user@example.com",
    });
  });
});
