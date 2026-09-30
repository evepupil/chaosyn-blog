import { getAllArticles, getAllBooks } from "@/lib/content/repository";
import { buildLlmsText } from "@/lib/seo/llms";

export const dynamic = "force-static";

export async function GET() {
  const [articles, books] = await Promise.all([
    getAllArticles(),
    getAllBooks(),
  ]);

  return new Response(buildLlmsText({ articles, books }), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
