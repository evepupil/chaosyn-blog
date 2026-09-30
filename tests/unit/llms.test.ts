import remarkParse from "remark-parse";
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import type { Article, Book } from "@/lib/content/types";
import { buildLlmsText } from "@/lib/seo/llms";

function createArticle(overrides: Partial<Article> = {}): Article {
  return {
    body: "Article body.",
    description: "A useful article description.",
    draft: false,
    headings: [],
    locale: "zh-CN",
    pinned: false,
    plainText: "Article body.",
    published: "2026-09-01",
    readTime: 1,
    slug: "example-article",
    sourcePath: "content/posts/zh/example-article.mdx",
    tags: ["AI"],
    title: "Example article",
    wordCount: 100,
    ...overrides,
  };
}

function createBook(overrides: Partial<Book> = {}): Book {
  return {
    body: "Book introduction.",
    chapters: [],
    description: "A useful book description.",
    draft: false,
    headings: [],
    locale: "zh-CN",
    order: 1,
    plainText: "Book introduction.",
    slug: "example-book",
    sourcePath: "content/books/zh/example-book/index.md",
    status: "complete",
    tags: ["AI"],
    title: "Example book",
    ...overrides,
  };
}

describe("llms.txt output", () => {
  it("lists published bilingual content and excludes drafts", () => {
    const output = buildLlmsText({
      articles: [
        createArticle({
          pinned: true,
          slug: "pinned-zh",
          title: "Pinned Chinese article",
        }),
        createArticle({
          locale: "en",
          slug: "english-article",
          sourcePath: "content/posts/en/english-article.mdx",
          title: "English article",
        }),
        createArticle({
          draft: true,
          slug: "hidden-draft",
          title: "Hidden draft",
        }),
      ],
      books: [
        createBook(),
        createBook({ draft: true, slug: "hidden-book", title: "Hidden book" }),
      ],
    });

    expect(output).toMatch(/^# 潮思Chaosyn\n\n>/u);
    expect(output).toContain("## Chinese articles");
    expect(output).toContain("## English articles");
    expect(output).toContain("## Books and guides");
    expect(output).toContain("/posts/pinned-zh/");
    expect(output).toContain("/en/posts/english-article/");
    expect(output).toContain("/books/example-book/");
    expect(output).not.toContain("hidden-draft");
    expect(output).not.toContain("hidden-book");
  });

  it("produces parseable Markdown with unique absolute links", () => {
    const output = buildLlmsText({
      articles: [
        createArticle({
          description: "A description\nwith extra spacing.",
          slug: "escaped-title",
          title: "A [bracketed] title",
        }),
      ],
      books: [],
    });
    const tree = unified().use(remarkParse).parse(output);
    const urls: string[] = [];
    visit(tree, "link", (node) => urls.push(node.url));

    expect(output).toContain("A \\[bracketed\\] title");
    expect(output).toContain("A description with extra spacing.");
    expect(urls.length).toBeGreaterThan(1);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.every((url) => URL.canParse(url))).toBe(true);
  });
});
