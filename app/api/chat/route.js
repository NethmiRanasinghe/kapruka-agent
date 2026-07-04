const MCP_URL = "https://mcp.kapruka.com/mcp";
const MODEL = "claude-sonnet-4-6";

// Allow this route up to 60 seconds — multi-tool MCP round trips
// (check delivery, search products, etc. in one turn) can take longer
// than Vercel's default function timeout.
export const maxDuration = 60;

// ---------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------
// This is public demo link with your API key behind it, so two simple,
// dependency-free protections:
//   1. Per-IP limit — stops one person/bot from hammering the endpoint.
//   2. Global limit — a hard ceiling on total requests per window across
//      everyone, so a burst of traffic (or several people at once) can't
//      run up an unexpectedly large bill.
//
// CAVEAT: this state lives in memory, so it resets whenever the
// serverless function cold-starts, and isn't shared across concurrent
// instances if Vercel scales this route out. That's an inherent
// limitation of "no extra service" rate limiting on serverless — it's a
// reasonable speed bump for a demo, not a hard guarantee. For durable,
// cross-instance limiting, move this state to Vercel KV or Upstash Redis
// (both have generous free tiers) — happy to wire that up if this needs
// to hold up under real traffic.
const PER_IP_WINDOW_MS = 60 * 1000;
const PER_IP_MAX_REQUESTS = 8; // ~8 messages/minute per visitor
const GLOBAL_WINDOW_MS = 60 * 1000;
const GLOBAL_MAX_REQUESTS = 40; // total messages/minute across all visitors

const ipRequestLog = new Map(); // ip -> timestamps[]
let globalRequestLog = []; // timestamps[]

function isRateLimited(ip) {
  const now = Date.now();

  const globalRecent = globalRequestLog.filter((t) => now - t < GLOBAL_WINDOW_MS);
  if (globalRecent.length >= GLOBAL_MAX_REQUESTS) {
    globalRequestLog = globalRecent;
    return { limited: true, scope: "global" };
  }

  const ipRecent = (ipRequestLog.get(ip) || []).filter((t) => now - t < PER_IP_WINDOW_MS);
  if (ipRecent.length >= PER_IP_MAX_REQUESTS) {
    ipRequestLog.set(ip, ipRecent);
    return { limited: true, scope: "ip" };
  }

  ipRecent.push(now);
  ipRequestLog.set(ip, ipRecent);
  globalRecent.push(now);
  globalRequestLog = globalRecent;
  return { limited: false };
}

// This route runs server-side only, so the API key never reaches the browser.
// Set ANTHROPIC_API_KEY in your Vercel project's Environment Variables
// (Project Settings → Environment Variables), then redeploy.
export async function POST(req) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const rateCheck = isRateLimited(ip);
    if (rateCheck.limited) {
      const message =
        rateCheck.scope === "ip"
          ? "You're sending messages a bit too quickly — please wait a moment and try again."
          : "This demo is getting a lot of traffic right now — please try again in a minute.";
      return Response.json({ error: { message } }, { status: 429 });
    }

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
