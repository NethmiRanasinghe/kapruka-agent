# Kapu — Kapruka AI Shopping Agent

A full-screen chat shopping agent for Kapruka.com, built on the [Kapruka MCP
server](https://mcp.kapruka.com) and Claude.

- `app/api/chat/route.js` — server-side route. Holds your Anthropic API key
  and attaches the Kapruka MCP server to every request. The key never
  reaches the browser.
- `components/KaprukaAgent.jsx` — the chat UI: product cards, cart drawer,
  guest checkout, order tracking.

## Run locally

```bash
npm install
cp .env.example .env.local   # then paste your real key into .env.local
npm run dev
```

Open http://localhost:3000.

## Deploy to Vercel

**Option A — GitHub (recommended, gives you auto-deploys on every push):**

1. Push this folder to a new GitHub repo:
   ```bash
   git init
   git add .
   git commit -m "Kapruka shopping agent"
   git branch -M main
   git remote add origin https://github.com/<you>/kapruka-agent.git
   git push -u origin main
   ```
2. Go to [vercel.com/new](https://vercel.com/new), import the repo. Vercel
   auto-detects Next.js — no config needed.
3. Before the first deploy (or right after, then redeploy), go to
   **Project Settings → Environment Variables** and add:
   - `ANTHROPIC_API_KEY` = your key from
     [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
4. Deploy. You'll get a public `https://kapruka-agent-xxxx.vercel.app` URL —
   that's the link to test on your phone and, if the challenge is still
   open, to submit.

**Option B — Vercel CLI, no GitHub needed:**

```bash
npm i -g vercel
vercel                # first deploy, follow prompts
vercel env add ANTHROPIC_API_KEY   # paste your key when prompted
vercel --prod         # redeploy so the env var takes effect
```

## Known rough edges to test against the live server

I built the tool-result parsing (`parseToolResult` in `KaprukaAgent.jsx`)
defensively — it doesn't yet reflect the *actual* JSON shape the Kapruka
tools return, only their documented names. Once deployed:

1. Open the app, click the bug icon (top right) to turn on debug mode.
2. Search for a product, check delivery, create a test order, track it.
3. Look at the raw JSON printed in the debug panel under each turn.
4. If product/order/tracking cards look wrong or blank, send me that raw
   JSON and I'll fix the field mapping in `parseToolResult`.

## Cost note

Every message is a real Anthropic API call (Claude Sonnet, `max_tokens:
1000`), billed to whatever key you put in `ANTHROPIC_API_KEY`. Fine for
testing and demoing; keep an eye on usage if this gets shared publicly.
