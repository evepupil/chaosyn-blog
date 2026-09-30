import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parse, type DefaultTreeAdapterMap } from "parse5";

import { getPostHref } from "@/features/posts/post-links";
import { getPublishedArticles } from "@/lib/content/queries";
import { loadArticles } from "@/lib/content/reader";
import { resolveProductionSiteUrl } from "@/lib/deployment/config";
import { redirectsConfig } from "@/redirects.config";

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

interface SmokeCheck {
  readonly expectedStatus: number;
  readonly kind: "html" | "json" | "text" | "xml";
  readonly locale?: "en" | "zh-CN";
  readonly path: string;
  readonly requireArticleJsonLd?: boolean;
  readonly requireSecurityHeaders?: boolean;
}

interface RedirectSmokeCheck {
  readonly from: string;
  readonly to: string;
}

function isHtmlElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function getHtmlChildren(node: HtmlNode): HtmlNode[] {
  return "childNodes" in node ? node.childNodes : [];
}

function findHtmlElements(
  node: HtmlNode,
  predicate: (element: HtmlElement) => boolean,
): HtmlElement[] {
  const matches = isHtmlElement(node) && predicate(node) ? [node] : [];
  for (const child of getHtmlChildren(node)) {
    matches.push(...findHtmlElements(child, predicate));
  }

  return matches;
}

function getHtmlAttribute(element: HtmlElement, name: string): string | null {
  return (
    element.attrs.find((attribute) => attribute.name === name)?.value ?? null
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchWithRetry(
  url: URL,
  expectedStatus: number,
): Promise<Response> {
  let lastError = "request did not run";

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: { "User-Agent": "hero-ui-blog-deployment-smoke/1.0" },
        redirect: "follow",
      });

      if (response.status === expectedStatus) {
        return response;
      }

      lastError = `received HTTP ${response.status}`;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (attempt < 6) {
      await delay(Math.min(1000 * 2 ** (attempt - 1), 5000));
    }
  }

  throw new Error(`${url.pathname}: ${lastError}.`);
}

async function validateRedirect(
  baseUrl: URL,
  check: RedirectSmokeCheck,
): Promise<string> {
  const url = new URL(check.from, baseUrl);
  let lastError = "request did not run";

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: { "User-Agent": "hero-ui-blog-deployment-smoke/1.0" },
        redirect: "manual",
      });
      const location = response.headers.get("location");
      const targetPath = location
        ? new URL(location, url).pathname
        : "missing location";

      if (response.status === 301 && targetPath === check.to) {
        return `${check.from} -> ${check.to} (301)`;
      }

      lastError = `received HTTP ${response.status} to ${targetPath}`;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (attempt < 6) {
      await delay(Math.min(1000 * 2 ** (attempt - 1), 5000));
    }
  }

  throw new Error(`${check.from}: ${lastError}.`);
}

function validateSecurityHeaders(response: Response, pathname: string) {
  const expectedHeaders = [
    "content-security-policy",
    "referrer-policy",
    "x-content-type-options",
    "x-frame-options",
  ];

  for (const name of expectedHeaders) {
    if (!response.headers.get(name)) {
      throw new Error(`${pathname}: missing ${name} response header.`);
    }
  }
}

async function validateHtml(
  response: Response,
  check: SmokeCheck,
): Promise<void> {
  const html = await response.text();
  const document = parse(html);
  const elements = findHtmlElements(document, () => true);
  const htmlElement = elements.find((element) => element.tagName === "html");
  const title = elements.find((element) => element.tagName === "title");
  const main = elements.find((element) => element.tagName === "main");

  if (!htmlElement || !title || !main || html.includes("__next_error__")) {
    throw new Error(`${check.path}: page shell is incomplete.`);
  }
  if (check.locale && getHtmlAttribute(htmlElement, "lang") !== check.locale) {
    throw new Error(`${check.path}: unexpected document language.`);
  }
  if (
    check.expectedStatus === 200 &&
    !elements.some(
      (element) =>
        element.tagName === "link" &&
        getHtmlAttribute(element, "rel") === "canonical",
    )
  ) {
    throw new Error(`${check.path}: canonical link is missing.`);
  }
  if (
    check.requireArticleJsonLd &&
    !elements.some(
      (element) =>
        element.tagName === "script" &&
        getHtmlAttribute(element, "type") === "application/ld+json",
    )
  ) {
    throw new Error(`${check.path}: article JSON-LD is missing.`);
  }
}

async function runCheck(baseUrl: URL, check: SmokeCheck): Promise<string> {
  const url = new URL(check.path, baseUrl);
  const response = await fetchWithRetry(url, check.expectedStatus);

  if (check.requireSecurityHeaders) {
    validateSecurityHeaders(response, check.path);
  }

  if (check.kind === "html") {
    await validateHtml(response, check);
  } else if (check.kind === "json") {
    const value: unknown = await response.json();
    if (!value || typeof value !== "object") {
      throw new Error(`${check.path}: response is not a JSON object.`);
    }
  } else if (check.kind === "xml") {
    const xml = await response.text();
    if (XMLValidator.validate(xml) !== true) {
      throw new Error(`${check.path}: response is not valid XML.`);
    }
    const value: unknown = new XMLParser().parse(xml);
    if (!value || typeof value !== "object") {
      throw new Error(`${check.path}: response is not valid XML.`);
    }
  } else {
    const text = await response.text();
    if (!text.trim()) {
      throw new Error(`${check.path}: response is empty.`);
    }
    if (check.path === "/robots.txt" && !text.includes("Sitemap:")) {
      throw new Error(`${check.path}: Sitemap declaration is missing.`);
    }
    if (
      check.path === "/llms.txt" &&
      (!response.headers
        .get("content-type")
        ?.match(/^text\/(?:plain|markdown)/u) ||
        !text.startsWith("# ") ||
        !text.includes("## Chinese articles") ||
        !text.includes("## English articles"))
    ) {
      throw new Error(`${check.path}: LLM content index is incomplete.`);
    }
  }

  return `${check.path} (${response.status})`;
}

async function main() {
  const baseUrl = resolveProductionSiteUrl(
    process.argv[2] ?? process.env.NEXT_PUBLIC_SITE_URL,
  );
  const allArticles = await loadArticles();
  const article = getPublishedArticles(allArticles, "zh-CN")[0];
  const englishArticle = getPublishedArticles(allArticles, "en")[0];
  if (!article) {
    throw new Error("Deployment smoke requires one published Chinese article.");
  }
  if (!englishArticle) {
    throw new Error("Deployment smoke requires one published English article.");
  }

  const checks: readonly SmokeCheck[] = [
    {
      expectedStatus: 200,
      kind: "html",
      locale: "zh-CN",
      path: "/",
      requireSecurityHeaders: true,
    },
    { expectedStatus: 200, kind: "html", locale: "en", path: "/en/" },
    { expectedStatus: 200, kind: "html", locale: "zh-CN", path: "/links/" },
    {
      expectedStatus: 200,
      kind: "html",
      locale: "zh-CN",
      path: getPostHref("zh-CN", article.slug),
      requireArticleJsonLd: true,
    },
    { expectedStatus: 200, kind: "xml", path: "/rss.xml" },
    { expectedStatus: 200, kind: "xml", path: "/en/rss.xml" },
    { expectedStatus: 200, kind: "xml", path: "/sitemap.xml" },
    { expectedStatus: 200, kind: "text", path: "/llms.txt" },
    { expectedStatus: 200, kind: "text", path: "/robots.txt" },
    {
      expectedStatus: 200,
      kind: "json",
      path: "/search-index/zh-CN.json",
    },
    {
      expectedStatus: 404,
      kind: "html",
      locale: "zh-CN",
      path: "/deployment-smoke-missing/",
    },
    {
      expectedStatus: 404,
      kind: "html",
      locale: "en",
      path: "/en/deployment-smoke-missing/",
    },
  ];
  const results = await Promise.all(
    checks.map((check) => runCheck(baseUrl, check)),
  );
  const redirectResults = await Promise.all(
    [
      {
        from: `/posts/en/${englishArticle.slug}/`,
        to: `/en/posts/${englishArticle.slug}/`,
      },
      { from: "/archive/", to: "/archives/" },
      { from: "/sitemap-index.xml", to: "/sitemap.xml" },
      ...redirectsConfig.postSlugs.map((mapping) => ({
        from: `/posts/${mapping.from}/`,
        to: `/posts/${mapping.to}/`,
      })),
    ].map((check) => validateRedirect(baseUrl, check)),
  );

  console.log(
    `Deployment smoke passed for ${baseUrl.origin}:\n${[
      ...results,
      ...redirectResults,
    ].join("\n")}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
