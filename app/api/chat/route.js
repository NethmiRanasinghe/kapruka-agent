const MCP_URL = "https://mcp.kapruka.com/mcp";
const MODEL = "claude-sonnet-4-6";

// This route runs server-side only, so the API key never reaches the browser.
// Set ANTHROPIC_API_KEY in your Vercel project's Environment Variables
// (Project Settings → Environment Variables), then redeploy.
export async function POST(req) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return Response.json(
        { error: { message: "ANTHROPIC_API_KEY is not set on the server." } },
        { status: 500 }
      );
    }

    const { messages, system } = await req.json();

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        // Required beta header for the MCP connector as of this writing.
        // If Anthropic has since made mcp_servers generally available,
        // this header becomes a harmless no-op — check docs.claude.com
        // if you hit a 400 mentioning "mcp_servers".
        "anthropic-beta": "mcp-client-2025-04-04",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system,
        messages,
        mcp_servers: [{ type: "url", url: MCP_URL, name: "kapruka" }],
      }),
    });

    const data = await res.json();
    return Response.json(data, { status: res.status });
  } catch (err) {
    return Response.json({ error: { message: err.message } }, { status: 500 });
  }
}
