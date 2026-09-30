import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { XMLParser } from "fast-xml-parser";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import { resolveSiteUrl } from "@/lib/site-config";
import {
  resolveCloudflareWebAnalyticsConfig,
  resolveGoogleAnalyticsConfig,
  resolveUmamiConfig,
} from "@/lib/analytics/config";
import { resolveAdSenseClientId } from "@/lib/monetization/config";
import {
  createRedirectRules,
  serializeRedirectRule,
} from "@/lib/redirects/generator";
import { redirectsConfig } from "@/redirects.config";

const outputDirectory = path.resolve("out");
const siteUrl = resolveSiteUrl();
const analytics = resolveUmamiConfig();
const cloudflareWebAnalytics = resolveCloudflareWebAnalyticsConfig();
const googleAnalytics = resolveGoogleAnalyticsConfig();
const adsenseClientId = resolveAdSenseClientId();
const requiredFiles = [
  "_headers",
  "_redirects",
  "_routes.json",
  "_worker.js",
  "404.html",
  "en/404.html",
  "en/404/index.html",
  "en/links/index.html",
  "en/rss.xml",
  "links/index.html",
  "llms.txt",
  "robots.txt",
  "rss.xml",
  "search-index/en.json",
  "search-index/zh-CN.json",
  "sitemap.xml",
] as const;

const requiredLegacyRedirects = createRedirectRules(redirectsConfig).map(
  serializeRedirectRule,
);

async function checkHeadersFile(errors: string[]): Promise<void> {
  const headers = await readFile(
    path.join(outputDirectory, "_headers"),
    "utf8",
  );
  const requiredRules = [
    "Content-Security-Policy:",
    "frame-src https://giscus.app https://googleads.g.doubleclick.net https://tpc.googlesyndication.com",
    "img-src 'self' data: https:",
    "https://cloud.umami.is",
    "https://gateway.umami.is",
    "https://static.cloudflareinsights.com",
    "https://cloudflareinsights.com",
    "https://pagead2.googlesyndication.com",
    "https://ep1.adtrafficquality.google",
    "https://www.google-analytics.com",
    "https://region1.google-analytics.com",
    "https://analytics.google.com",
    "https://www.googletagmanager.com",
    "script-src 'self' 'unsafe-inline' https://giscus.app https://cloud.umami.is https://static.cloudflareinsights.com https://pagead2.googlesyndication.com https://www.googletagmanager.com",
    "Permissions-Policy:",
    "Referrer-Policy:",
    "X-Content-Type-Options: nosniff",
    "X-Frame-Options: DENY",
    "/_next/static/*",
    "max-age=31536000, immutable",
    "/search-index/*",
  ];

  for (const rule of requiredRules) {
    if (!headers.includes(rule)) {
      errors.push(`_headers: missing required rule ${rule}.`);
    }
  }
}

async function checkRedirectsFile(errors: string[]): Promise<void> {
  const redirects = await readFile(
    path.join(outputDirectory, "_redirects"),
    "utf8",
  );
  const rules = new Set(
    redirects
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );

  for (const rule of requiredLegacyRedirects) {
    if (!rules.has(rule)) {
      errors.push(`_redirects: missing required legacy rule ${rule}.`);
    }
  }
}

async function checkWorkerRoutesFile(errors: string[]): Promise<void> {
  const source = await readFile(
    path.join(outputDirectory, "_routes.json"),
    "utf8",
  );
  let routes: unknown;
  try {
    routes = JSON.parse(source);
  } catch {
    errors.push("_routes.json: invalid JSON.");
    return;
  }

  if (
    !routes ||
    typeof routes !== "object" ||
    Array.isArray(routes) ||
    Reflect.get(routes, "version") !== 1 ||
    JSON.stringify(Reflect.get(routes, "include")) !== '["/api/*"]' ||
    JSON.stringify(Reflect.get(routes, "exclude")) !== "[]"
  ) {
    errors.push("_routes.json: only /api/* may run through the Worker.");
  }
}

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

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

function getHtmlText(node: HtmlNode): string {
  if ("value" in node && node.nodeName === "#text") {
    return node.value;
  }

  return getHtmlChildren(node).map(getHtmlText).join("");
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? collectFiles(entryPath) : [entryPath];
    }),
  );

  return files.flat();
}

function getRelativePath(filePath: string): string {
  return path.relative(outputDirectory, filePath).replaceAll("\\", "/");
}

function getRoutePath(relativePath: string): string {
  if (relativePath === "index.html") {
    return "/";
  }

  if (relativePath === "404.html" || relativePath === "404/index.html") {
    return "/404.html";
  }

  return `/${relativePath.replace(/index\.html$/u, "")}`;
}

function getExpectedLocale(relativePath: string): "en" | "zh-CN" {
  return relativePath.startsWith("en/") ? "en" : "zh-CN";
}

function getOutputCandidates(pathname: string): string[] {
  const decodedPath = decodeURIComponent(pathname);
  const segments = decodedPath.split("/").filter(Boolean);

  if (segments.some((segment) => segment === "." || segment === "..")) {
    return [];
  }

  const relativePath = segments.join(path.sep);
  if (!relativePath) {
    return [path.join(outputDirectory, "index.html")];
  }

  return [
    path.join(outputDirectory, relativePath),
    path.join(outputDirectory, `${relativePath}.html`),
    path.join(outputDirectory, relativePath, "index.html"),
  ];
}

async function outputPathExists(pathname: string): Promise<boolean> {
  for (const candidate of getOutputCandidates(pathname)) {
    if (!candidate.startsWith(outputDirectory)) {
      continue;
    }

    try {
      const candidateStat = await stat(candidate);
      if (candidateStat.isFile() || candidateStat.isDirectory()) {
        return true;
      }
    } catch {
      // Try the next valid static-export shape.
    }
  }

  return false;
}

function getLocalUrl(value: string, routePath: string): URL | null {
  if (
    !value ||
    value.startsWith("#") ||
    value.startsWith("data:") ||
    value.startsWith("mailto:") ||
    value.startsWith("tel:")
  ) {
    return null;
  }

  const pageUrl = new URL(routePath, siteUrl);
  const target = new URL(value, pageUrl);

  return target.origin === siteUrl.origin ? target : null;
}

async function checkHtmlFile(
  filePath: string,
  errors: string[],
): Promise<void> {
  const relativePath = getRelativePath(filePath);
  if (relativePath.startsWith("_not-found/")) {
    return;
  }

  const routePath = getRoutePath(relativePath);
  const htmlSource = await readFile(filePath, "utf8");
  const document = parse(htmlSource);
  const elements = findHtmlElements(document, () => true);
  const html = elements.find((element) => element.tagName === "html");
  const expectedLocale = getExpectedLocale(relativePath);
  const isNotFoundPage =
    relativePath === "404.html" ||
    relativePath === "404/index.html" ||
    relativePath === "en/404.html" ||
    relativePath === "en/404/index.html";

  if (
    analytics &&
    !isNotFoundPage &&
    (!htmlSource.includes(analytics.websiteId) ||
      !htmlSource.includes(analytics.scriptUrl))
  ) {
    errors.push(`${relativePath}: missing configured Umami analytics script.`);
  }

  if (
    cloudflareWebAnalytics &&
    !isNotFoundPage &&
    (!htmlSource.includes(cloudflareWebAnalytics.token) ||
      !htmlSource.includes(cloudflareWebAnalytics.scriptUrl))
  ) {
    errors.push(
      `${relativePath}: missing configured Cloudflare Web Analytics script.`,
    );
  }

  if (
    adsenseClientId &&
    !isNotFoundPage &&
    !elements.some(
      (element) =>
        element.tagName === "meta" &&
        getHtmlAttribute(element, "name") === "google-adsense-account" &&
        getHtmlAttribute(element, "content") === adsenseClientId,
    )
  ) {
    errors.push(`${relativePath}: missing Google AdSense account metadata.`);
  }

  if (
    googleAnalytics &&
    !isNotFoundPage &&
    !elements.some(
      (element) =>
        element.tagName === "meta" &&
        getHtmlAttribute(element, "name") === "google-analytics-id" &&
        getHtmlAttribute(element, "content") === googleAnalytics.measurementId,
    )
  ) {
    errors.push(`${relativePath}: missing Google Analytics metadata.`);
  }

  if (!html || getHtmlAttribute(html, "lang") !== expectedLocale) {
    errors.push(`${relativePath}: expected html lang ${expectedLocale}.`);
  }

  const canonicalLinks = elements.filter(
    (element) =>
      element.tagName === "link" &&
      getHtmlAttribute(element, "rel") === "canonical",
  );
  if (isNotFoundPage) {
    const robots = elements.find(
      (element) =>
        element.tagName === "meta" &&
        getHtmlAttribute(element, "name") === "robots",
    );
    if (!robots || !getHtmlAttribute(robots, "content")?.includes("noindex")) {
      errors.push(`${relativePath}: not-found page must be noindex.`);
    }
  } else if (canonicalLinks.length !== 1) {
    errors.push(`${relativePath}: expected exactly one canonical link.`);
  } else {
    const canonicalValue = canonicalLinks[0]
      ? getHtmlAttribute(canonicalLinks[0], "href")
      : null;
    if (!canonicalValue) {
      errors.push(`${relativePath}: canonical link has no href.`);
    } else {
      const canonicalPath = decodeURIComponent(
        new URL(canonicalValue).pathname,
      );
      if (canonicalPath !== decodeURIComponent(routePath)) {
        errors.push(
          `${relativePath}: canonical path ${canonicalPath} does not match ${routePath}.`,
        );
      }
    }
  }

  const currentAlternate = elements.find(
    (element) =>
      element.tagName === "link" &&
      getHtmlAttribute(element, "rel") === "alternate" &&
      getHtmlAttribute(element, "hreflang") === expectedLocale,
  );
  if (!isNotFoundPage && !currentAlternate) {
    errors.push(`${relativePath}: missing current-language hreflang.`);
  }

  if (
    !elements.some(
      (element) =>
        element.tagName === "meta" &&
        getHtmlAttribute(element, "property") === "og:image",
    )
  ) {
    errors.push(`${relativePath}: missing Open Graph image.`);
  }
  if (
    !elements.some(
      (element) =>
        element.tagName === "meta" &&
        getHtmlAttribute(element, "name") === "twitter:card",
    )
  ) {
    errors.push(`${relativePath}: missing Twitter card.`);
  }

  if (/^\/(?:en\/)?posts\/[^/]+\/$/u.test(routePath)) {
    const jsonLd = elements.find(
      (element) =>
        element.tagName === "script" &&
        getHtmlAttribute(element, "type") === "application/ld+json",
    );
    if (!jsonLd) {
      errors.push(`${relativePath}: article page is missing JSON-LD.`);
    } else {
      try {
        JSON.parse(getHtmlText(jsonLd));
      } catch {
        errors.push(`${relativePath}: article JSON-LD is invalid JSON.`);
      }
    }
  }

  const references = elements.filter(
    (element) =>
      ((element.tagName === "a" || element.tagName === "link") &&
        getHtmlAttribute(element, "href")) ||
      ((element.tagName === "img" || element.tagName === "script") &&
        getHtmlAttribute(element, "src")),
  );

  for (const element of references) {
    const value =
      getHtmlAttribute(element, "href") ?? getHtmlAttribute(element, "src");
    if (!value) {
      continue;
    }

    let target: URL | null;
    try {
      target = getLocalUrl(value, routePath);
    } catch {
      errors.push(`${relativePath}: invalid URL ${value}.`);
      continue;
    }

    if (target && !(await outputPathExists(target.pathname))) {
      errors.push(`${relativePath}: missing local target ${target.pathname}.`);
    }
  }
}

async function checkXmlUrls(
  relativePath: "en/rss.xml" | "rss.xml" | "sitemap.xml",
  errors: string[],
): Promise<void> {
  const filePath = path.join(outputDirectory, relativePath);
  const xml = await readFile(filePath, "utf8");
  const parser = new XMLParser({ ignoreAttributes: false });

  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    errors.push(`${relativePath}: invalid XML.`);
    return;
  }

  const values: string[] = [];
  const visit = (value: unknown, key?: string) => {
    if (typeof value === "string" && (key === "link" || key === "loc")) {
      values.push(value);
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      visit(childValue, childKey);
    }
  };
  visit(parsed);

  for (const value of values) {
    const target = new URL(value);
    if (
      target.origin === siteUrl.origin &&
      !(await outputPathExists(target.pathname))
    ) {
      errors.push(`${relativePath}: missing listed URL ${target.pathname}.`);
    }
  }
}

async function checkLlmsFile(errors: string[]): Promise<void> {
  const relativePath = "llms.txt";
  const source = await readFile(
    path.join(outputDirectory, relativePath),
    "utf8",
  );
  const tree = unified().use(remarkParse).parse(source);
  const firstNode = tree.children[0];

  if (firstNode?.type !== "heading" || firstNode.depth !== 1) {
    errors.push(`${relativePath}: first element must be one H1 heading.`);
  }
  if (!tree.children.some((node) => node.type === "blockquote")) {
    errors.push(`${relativePath}: site summary blockquote is missing.`);
  }
  if (Buffer.byteLength(source, "utf8") > 128 * 1024) {
    errors.push(`${relativePath}: file exceeds the 128 KiB context budget.`);
  }

  const urls: string[] = [];
  visit(tree, "link", (node) => urls.push(node.url));
  if (urls.length === 0) {
    errors.push(`${relativePath}: no content links were found.`);
    return;
  }

  const seen = new Set<string>();
  for (const value of urls) {
    let target: URL;
    try {
      target = new URL(value, siteUrl);
    } catch {
      errors.push(`${relativePath}: invalid URL ${value}.`);
      continue;
    }

    if (seen.has(target.toString())) {
      errors.push(`${relativePath}: duplicate URL ${target.toString()}.`);
      continue;
    }
    seen.add(target.toString());

    if (
      target.origin === siteUrl.origin &&
      !(await outputPathExists(target.pathname))
    ) {
      errors.push(`${relativePath}: missing local target ${target.pathname}.`);
    }
  }
}

async function main() {
  const errors: string[] = [];

  for (const relativePath of requiredFiles) {
    try {
      await access(path.join(outputDirectory, relativePath));
    } catch {
      errors.push(`Missing required output: ${relativePath}.`);
    }
  }

  const files = await collectFiles(outputDirectory);
  const htmlFiles = files.filter((filePath) => filePath.endsWith(".html"));
  await Promise.all(
    htmlFiles.map((filePath) => checkHtmlFile(filePath, errors)),
  );
  await checkHeadersFile(errors);
  await checkRedirectsFile(errors);
  await checkWorkerRoutesFile(errors);
  await checkLlmsFile(errors);
  await Promise.all(
    (["rss.xml", "en/rss.xml", "sitemap.xml"] as const).map((relativePath) =>
      checkXmlUrls(relativePath, errors),
    ),
  );

  if (errors.length > 0) {
    throw new Error(`Static output check failed:\n${errors.join("\n")}`);
  }

  console.log(
    `Static output validated: ${htmlFiles.length} HTML files, llms.txt, RSS, sitemap and assets.`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
