import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertUrlAllowed,
  normalizeUrlPattern,
  parseAllowedUrls,
  toUrlAllowList,
} from "../src/allowlist";
import { approvalMatches, resolveWebSearchConfig } from "../src/config";
import { htmlToText } from "../src/fetch";
import {
  detectWebSearchProvider,
  supportsWebSearch,
  webSearchToolSpec,
  WEB_SEARCH_PROVIDERS,
} from "../src/provider";

describe("web-search allow-list", () => {
  it("strips the scheme from entries, leaving host / path verbatim", () => {
    assert.equal(normalizeUrlPattern("https://*.databricks.com"), "*.databricks.com");
    assert.equal(normalizeUrlPattern("docs.example.com/api/**"), "docs.example.com/api/**");
    assert.equal(normalizeUrlPattern("databricks.com"), "databricks.com");
  });

  it("parses CSV and array forms, trimming + de-duping", () => {
    assert.deepEqual(parseAllowedUrls("https://databricks.com, docs.example.com"), [
      "databricks.com",
      "docs.example.com",
    ]);
    assert.deepEqual(parseAllowedUrls(["databricks.com", "databricks.com"]), ["databricks.com"]);
  });

  it("permits everything when unconfigured", () => {
    const list = toUrlAllowList(parseAllowedUrls(undefined));
    assert.equal(list.restricted, false);
    assert.equal(list.allows("https://anything.example.com/x"), true);
  });

  it("a bare host permits the host and its subdomains, blocks others", () => {
    const list = toUrlAllowList(parseAllowedUrls(["databricks.com", "*.trusted.io"]));
    assert.equal(list.restricted, true);
    assert.equal(list.allows("https://databricks.com/"), true);
    assert.equal(list.allows("https://docs.databricks.com/aws/en/index.html"), true);
    assert.equal(list.allows("https://api.trusted.io/v1"), true);
    assert.equal(list.allows("https://evil.example.com/"), false);
    assert.equal(list.allows("https://notdatabricks.com/"), false);
  });

  it("a path entry constrains the pathname", () => {
    const list = toUrlAllowList(parseAllowedUrls(["docs.example.com/api/**"]));
    assert.equal(list.allows("https://docs.example.com/api/v1/x"), true);
    assert.equal(list.allows("https://docs.example.com/blog/x"), false);
  });

  it("assertUrlAllowed throws for a disallowed URL, passes an allowed one", () => {
    const list = toUrlAllowList(parseAllowedUrls(["databricks.com"]));
    assert.throws(() => assertUrlAllowed("https://evil.example.com/", list), /not permitted/);
    assert.doesNotThrow(() => assertUrlAllowed("https://databricks.com/", list));
  });
});

describe("web-search provider detection", () => {
  it("maps GPT ids to openai and Gemini ids to gemini", () => {
    assert.equal(detectWebSearchProvider("databricks-gpt-5"), "openai");
    assert.equal(detectWebSearchProvider("databricks-gpt-5-mini"), "openai");
    assert.equal(detectWebSearchProvider("databricks-gemini-3-pro"), "gemini");
    assert.equal(detectWebSearchProvider("databricks-gemini-2-5-flash"), "gemini");
  });

  it("treats gpt-oss and non-web families as unsupported", () => {
    assert.equal(detectWebSearchProvider("databricks-gpt-oss-120b"), null);
    assert.equal(detectWebSearchProvider("databricks-claude-sonnet-4-6"), null);
    assert.equal(detectWebSearchProvider("databricks-llama-3-70b"), null);
    assert.equal(supportsWebSearch("databricks-claude-sonnet-4-6"), false);
    assert.equal(supportsWebSearch("databricks-gpt-5"), true);
  });

  it("uses the built-in tool spec per provider", () => {
    assert.deepEqual(webSearchToolSpec("openai").tool, { type: "web_search" });
    assert.equal(webSearchToolSpec("openai").api, "responses");
    assert.deepEqual(webSearchToolSpec("gemini").tool, { google_search: {} });
    assert.equal(webSearchToolSpec("gemini").api, "chat");
    assert.deepEqual(WEB_SEARCH_PROVIDERS.openai.tool, { type: "web_search" });
  });

  it("merges an operator override over the built-in map", () => {
    const overrides = { gemini: { tool: { google_search_retrieval: {} } } };
    const spec = webSearchToolSpec("gemini", overrides);
    assert.deepEqual(spec.tool, { google_search_retrieval: {} });
    // api falls through to the built-in when not overridden
    assert.equal(spec.api, "chat");
    // other providers keep their defaults
    assert.deepEqual(webSearchToolSpec("openai", overrides).tool, { type: "web_search" });
  });
});

describe("web-search config", () => {
  it("defaults model fallbacks to Gemini-then-GPT and approval to none", () => {
    const c = resolveWebSearchConfig();
    assert.equal(c.approval, false);
    assert.equal(c.model, undefined);
    assert.match(c.modelFallbacks[0]!, /gemini/);
    assert.ok(c.modelFallbacks.some((m) => m.includes("gpt")));
  });

  it("merges webSearchTools override into resolved config", () => {
    const c = resolveWebSearchConfig({ webSearchTools: { gemini: { tool: { x: {} } } } });
    assert.deepEqual((c.webSearchTools as { gemini: unknown }).gemini, { tool: { x: {} } });
  });

  it("enables the scrape fallback by default, honors an explicit off", () => {
    assert.equal(resolveWebSearchConfig().scrapeFallback, true);
    assert.equal(resolveWebSearchConfig({ scrapeFallback: false }).scrapeFallback, false);
  });
});

describe("web-search approval gate", () => {
  it("boolean gates pass through", () => {
    assert.equal(approvalMatches(true, ["https://x.com"]), true);
    assert.equal(approvalMatches(false, ["https://x.com"]), false);
  });

  it("pattern gate matches only candidate URLs it covers", () => {
    assert.equal(
      approvalMatches("*.internal.example.com", ["https://api.internal.example.com/x"]),
      true,
    );
    assert.equal(
      approvalMatches("*.internal.example.com", ["https://public.example.com/x"]),
      false,
    );
    assert.equal(approvalMatches(["a.com", "b.com"], ["https://b.com/y"]), true);
  });
});

describe("web-search html-to-text", () => {
  it("strips script/style and unwraps tags", () => {
    const html =
      "<html><head><title>Hi</title><style>.x{}</style></head><body><p>One</p><script>bad()</script><p>Two</p></body></html>";
    const text = htmlToText(html);
    assert.match(text, /One/);
    assert.match(text, /Two/);
    assert.doesNotMatch(text, /bad\(\)/);
    assert.doesNotMatch(text, /\.x\{\}/);
  });

  it("decodes common entities", () => {
    assert.equal(htmlToText("<p>a &amp; b &lt;c&gt;</p>"), "a & b <c>");
  });
});
