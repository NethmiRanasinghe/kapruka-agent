// Kapruka's search/list tools don't return product images — only a link to
// the product page. This route fetches that page server-side and pulls the
// og:image meta tag, so the UI can show the real product photo instead of
// an emoji placeholder. Runs server-side to avoid CORS and keep this fast
// and cache-friendly (Vercel will cache GETs to this route at the edge).

export const revalidate = 3600; // cache each product's image for an hour

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");

  if (!url || !/^https:\/\/(www\.)?kapruka\.com\//.test(url)) {
    return Response.json({ error: "Missing or invalid Kapruka product URL" }, { status: 400 });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KapruAgent/1.0)" },
    });
    clearTimeout(timeout);

    if (!res.ok) return Response.json({ image: null }, { status: 200 });

    const html = await res.text();
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

    return Response.json({ image: ogMatch ? ogMatch[1] : null }, { status: 200 });
  } catch (err) {
    return Response.json({ image: null, error: err.message }, { status: 200 });
  }
}
