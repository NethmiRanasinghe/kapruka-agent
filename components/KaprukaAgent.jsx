"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  ShoppingBag, X, Send, Gift, MapPin, Package, Truck, Sparkles,
  Plus, Minus, Trash2, ExternalLink, Loader2, Bug, Leaf, ChevronDown
} from "lucide-react";

/* ────────────────────────────────────────────────────────────────────────
   KAPRUKA AI SHOPPING AGENT — prototype
   ------------------------------------------------------------------------
   - Talks to Claude via the Anthropic Messages API with the Kapruka MCP
     server attached directly (mcp_servers param) — Claude decides which
     of the 7 Kapruka tools to call, the API executes them server-side,
     and returns text + mcp_tool_use + mcp_tool_result blocks.
   - Cart is client-side state (the MCP has no cart tool) — "Add to cart"
     never calls the API, only checkout does.
   - Parsing of tool results is defensive: I don't have the live JSON
     shapes, only the documented tool + param names, so parseToolResult()
     tries several common key names and falls back to a readable raw
     card. Flip the bug icon (bottom-left) on to see exactly what each
     tool returned and tighten the parsing once you're hitting the real
     server.
   ──────────────────────────────────────────────────────────────────────── */

const SYSTEM_PROMPT = `You are Kapu, the shopping assistant for Kapruka.com, Sri Lanka's largest local e-commerce site. You help people search the catalog, check delivery, build a cart, check out as a guest, and track orders — using the connected Kapruka tools for every real fact. Never invent products, prices, stock, delivery dates, or order numbers — always call a tool.

Personality: warm, a little playful, genuinely knowledgeable about Sri Lankan gifting culture (Avurudu, Vesak, Christmas, homecomings, "malli/nangi's birthday", office parties). Keep replies short and conversational, not salesy. Use at most one emoji per message, if any (🎁🌸✅).

Language: default to English. If the customer writes in Sinhala, reply in Sinhala. If they write in Tamil, reply in Tamil. If they mix English with Sinhala/Tamil ("Tanglish"/"Singlish"), mirror that mix naturally. Never switch languages on them unprompted.

Rules:
- Before creating an order, always call kapruka_check_delivery for the city + date + a representative product, and mention the flat delivery rate and any perishable warning to the customer.
- When asked to check out, call kapruka_create_order with the full cart, recipient, delivery, sender, and gift_message fields as given. After it returns, clearly state the order number and the pay-link, and tell them the price is locked for 60 minutes.
- For order status questions, call kapruka_track_order with the order number.
- Keep tool-result summaries brief in your text — the interface renders the actual product cards, delivery info, and order details separately, so you don't need to repeat every field back in prose.`;

/* ---------- tiny defensive helpers for unknown JSON shapes ---------- */

function firstArray(obj, keys) {
  if (!obj) return null;
  for (const k of keys) {
    if (Array.isArray(obj[k])) return obj[k];
  }
  return null;
}

function pick(obj, keys, fallback) {
  if (!obj) return fallback;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return fallback;
}

function extractText(resultContent) {
  if (!Array.isArray(resultContent)) return "";
  return resultContent
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("\n");
}

function tryParseJSON(text) {
  if (!text) return null;
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function formatMoney(amount, currency) {
  if (amount === undefined || amount === null || amount === "") return null;
  const n = typeof amount === "number" ? amount : parseFloat(amount);
  if (Number.isNaN(n)) return String(amount);
  const cur = currency || "LKR";
  return `${cur} ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/** Very small **bold** / line / "- bullet" renderer for markdown-ish tool text. */
function LiteMarkdown({ text }) {
  if (!text) return null;
  const lines = text.split("\n");
  return (
    <div className="lite-md">
      {lines.map((line, i) => {
        const bulleted = /^\s*[-*]\s+/.test(line);
        const content = line.replace(/^\s*[-*]\s+/, "");
        const parts = content.split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
          p.startsWith("**") && p.endsWith("**") ? (
            <strong key={j}>{p.slice(2, -2)}</strong>
          ) : (
            <React.Fragment key={j}>{p}</React.Fragment>
          )
        );
        if (!content.trim()) return <div key={i} style={{ height: 6 }} />;
        return bulleted ? (
          <div key={i} className="lite-md-bullet">
            <span className="lite-md-dot" />
            <span>{parts}</span>
          </div>
        ) : (
          <p key={i}>{parts}</p>
        );
      })}
    </div>
  );
}

/* ---------- parsers for the markdown-formatted tool results Kapruka actually returns ---------- */

// Matches blocks like:
// **1. Product Name**
//    ID: `SOME_ID` · LKR 1,000 · In stock (low) · ships internationally
//    [View product](https://...)
function parseProductsFromMarkdown(text) {
  if (!text) return [];
  const products = [];
  const blockRegex = /\*\*(?:\d+\.\s*)?([^*]+?)\*\*\s*\n\s*ID:\s*`([^`]+)`([^\n]*)\n\s*\[View product\]\(([^)]+)\)/g;
  let m;
  while ((m = blockRegex.exec(text)) !== null) {
    const [, name, id, meta, url] = m;
    const priceMatch = meta.match(/LKR\s*([\d,]+(?:\.\d+)?)/i);
    const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, "")) : null;
    const outOfStock = /out of stock/i.test(meta);
    const lowStock = !outOfStock && /low/i.test(meta);
    products.push({
      id: id.trim(),
      name: name.trim(),
      price,
      currency: "LKR",
      url: url.trim(),
      inStock: !outOfStock,
      lowStock,
      image: null,
    });
  }
  return products;
}

// Matches a markdown link list: - [Category Name](https://...)
function parseCategoriesFromMarkdown(text) {
  if (!text) return [];
  const categories = [];
  const re = /[-*]\s*\[([^\]]+)\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    categories.push({ name: m[1].trim(), url: m[2].trim() });
  }
  return categories;
}

const EMOJI_RULES = [
  [/cake/i, "🎂"], [/mug|cup/i, "☕"], [/voucher/i, "🎟️"], [/puzzle|toy/i, "🧩"],
  [/flower/i, "🌸"], [/chocolate/i, "🍫"], [/fruit/i, "🍎"], [/jewel/i, "💍"],
  [/perfume/i, "🌺"], [/book/i, "📖"], [/wine|liquor/i, "🍷"], [/pet/i, "🐾"],
  [/baby/i, "🍼"], [/plant/i, "🪴"], [/watch/i, "⌚"], [/bag/i, "👜"],
];
function guessEmoji(name) {
  for (const [re, emoji] of EMOJI_RULES) if (re.test(name)) return emoji;
  return "🎁";
}

const CATEGORY_ICON_RULES = [
  [/cake/i, "🎂"], [/flower/i, "🌸"], [/chocolate/i, "🍫"], [/fruit|vegetable/i, "🍎"],
  [/jewel/i, "💍"], [/perfume/i, "🌺"], [/book/i, "📖"], [/toy|kid|child/i, "🧸"],
  [/liquor|wine/i, "🍷"], [/pet/i, "🐾"], [/baby/i, "🍼"], [/grocery/i, "🛒"],
  [/electronic/i, "🔌"], [/cloth|fashion/i, "👕"], [/wedding|bride/i, "💒"],
  [/birthday/i, "🎈"], [/anniversary|lover|valentine|youandme/i, "❤️"],
  [/christmas/i, "🎄"], [/gift/i, "🎁"], [/corporate/i, "💼"], [/pharmacy|ayurvedic/i, "💊"],
  [/sport/i, "🏸"], [/home|household/i, "🏠"], [/automobile|bicycle/i, "🚲"],
];
function guessCategoryIcon(name) {
  for (const [re, emoji] of CATEGORY_ICON_RULES) if (re.test(name)) return emoji;
  return "🏷️";
}

/* ---------- parse a single mcp_tool_result into a renderable shape ---------- */

function parseToolResult(toolName, resultContent, isError) {
  const rawText = extractText(resultContent);
  const json = tryParseJSON(rawText);

  if (isError) {
    return { kind: "error", message: rawText || "That request didn't go through." };
  }

  if (toolName === "kapruka_search_products") {
    const arr = json && (firstArray(json, ["products", "results", "items", "data"]) || (Array.isArray(json) ? json : null));
    if (arr) {
      return { kind: "products", products: arr.map(normalizeProduct), raw: json };
    }
    const mdProducts = parseProductsFromMarkdown(rawText);
    if (mdProducts.length) return { kind: "products", products: mdProducts, raw: rawText };
  }

  if (toolName === "kapruka_get_product") {
    const obj = json ? (json.product || json) : null;
    if (obj && (obj.id || obj.product_id || obj.name || obj.title)) {
      return { kind: "products", products: [normalizeProduct(obj)], raw: json };
    }
    const mdProducts = parseProductsFromMarkdown(rawText);
    if (mdProducts.length) return { kind: "products", products: mdProducts, raw: rawText };
  }

  if (toolName === "kapruka_list_categories") {
    const arr = json && firstArray(json, ["categories", "results", "items"]);
    if (arr) return { kind: "categories", categories: arr, raw: json };
    const mdCats = parseCategoriesFromMarkdown(rawText);
    if (mdCats.length) return { kind: "categories", categories: mdCats, raw: rawText };
  }

  if (toolName === "kapruka_list_delivery_cities") {
    const arr = json && firstArray(json, ["cities", "results", "items", "matches"]);
    if (arr) return { kind: "cities", cities: arr, raw: json };
    const mdCats = parseCategoriesFromMarkdown(rawText); // cities often come as the same link-list format
    if (mdCats.length) return { kind: "cities", cities: mdCats, raw: rawText };
  }

  if (toolName === "kapruka_check_delivery") {
    if (json && typeof json === "object") {
      return {
        kind: "delivery",
        deliverable: pick(json, ["deliverable", "available", "can_deliver"], true),
        rate: pick(json, ["rate", "fee", "delivery_fee", "amount"], null),
        currency: pick(json, ["currency"], "LKR"),
        city: pick(json, ["city"], null),
        date: pick(json, ["delivery_date", "date"], null),
        perishable: pick(json, ["perishable_warning", "perishable", "warning"], null),
        raw: json,
      };
    }
  }

  if (toolName === "kapruka_create_order") {
    if (json && typeof json === "object") {
      return {
        kind: "order",
        orderNumber: pick(json, ["order_number", "order_id", "id"], null),
        payUrl: pick(json, ["pay_url", "payment_url", "pay_link", "checkout_url", "url"], null),
        total: pick(json, ["total", "amount", "grand_total"], null),
        currency: pick(json, ["currency"], "LKR"),
        status: pick(json, ["status"], "pending payment"),
        expiresAt: pick(json, ["expires_at", "price_locked_until", "expiry"], null),
        raw: json,
      };
    }
  }

  if (toolName === "kapruka_track_order") {
    if (json && typeof json === "object") {
      const events = firstArray(json, ["timeline", "events", "history", "progress"]) || [];
      return {
        kind: "tracking",
        orderNumber: pick(json, ["order_number", "order_id", "id"], null),
        status: pick(json, ["status"], "unknown"),
        recipient: pick(json, ["recipient", "recipient_name"], null),
        items: firstArray(json, ["items", "cart"]) || [],
        events,
        raw: json,
      };
    }
  }

  // fallback: unrecognized shape — render the raw text nicely
  return { kind: "raw", text: rawText || JSON.stringify(json ?? {}, null, 2) };
}

function normalizeProduct(p) {
  const images = firstArray(p, ["images", "photos"]);
  return {
    id: pick(p, ["id", "product_id", "sku"], String(Math.random())),
    name: pick(p, ["name", "title"], "Kapruka product"),
    price: pick(p, ["price", "unit_price", "amount", "sale_price"], null),
    currency: pick(p, ["currency"], "LKR"),
    image: pick(p, ["image", "image_url", "thumbnail"], images ? images[0] : null),
    url: pick(p, ["url", "product_url", "link"], null),
    inStock: pick(p, ["in_stock", "available", "stock"], true),
    lowStock: false,
    category: pick(p, ["category"], null),
  };
}

/* ────────────────────────────────────────────────────────────────────── */

export default function KaprukaAgent() {
  const [turns, setTurns] = useState([
    {
      role: "assistant",
      blocks: [
        {
          type: "text",
          text:
            "Ayubowan! 🌸 I'm Kapu — I can help you find something on Kapruka, check delivery to any city, and check out as a guest. What are you shopping for today?",
        },
      ],
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [cart, setCart] = useState([]); // {id, name, price, currency, image, qty}
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [lastDebug, setLastDebug] = useState(null);
  const [errorBanner, setErrorBanner] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, loading]);

  const cartCount = cart.reduce((s, i) => s + i.qty, 0);
  const cartSubtotal = cart.reduce((s, i) => s + (Number(i.price) || 0) * i.qty, 0);
  const cartCurrency = cart[0]?.currency || "LKR";

  function addToCart(product) {
    setCart((prev) => {
      const existing = prev.find((i) => i.id === product.id);
      if (existing) {
        return prev.map((i) => (i.id === product.id ? { ...i, qty: i.qty + 1 } : i));
      }
      return [...prev, { ...product, qty: 1 }];
    });
    setCartOpen(true);
  }

  function updateQty(id, delta) {
    setCart((prev) =>
      prev
        .map((i) => (i.id === id ? { ...i, qty: i.qty + delta } : i))
        .filter((i) => i.qty > 0)
    );
  }

  function removeFromCart(id) {
    setCart((prev) => prev.filter((i) => i.id !== id));
  }

  /* ---------- core: send a message to Claude + the Kapruka MCP ---------- */

  const sendToAgent = useCallback(
    async (userText, displayLabel) => {
      if (!userText.trim() || loading) return;
      setErrorBanner(null);

      const userTurn = {
        role: "user",
        blocks: [{ type: "text", text: userText }],
        displayLabel, // optional friendlier label shown in the bubble
      };
      const nextTurns = [...turns, userTurn];
      setTurns(nextTurns);
      setInput("");
      setLoading(true);

      try {
        const apiMessages = nextTurns.map((t) => ({
          role: t.role,
          content: t.blocks,
        }));

        // Calls our own server-side route (app/api/chat/route.js), which holds
        // the Anthropic API key and attaches the Kapruka MCP server. The
        // browser never sees the key.
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system: SYSTEM_PROMPT,
            messages: apiMessages,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data?.error?.message || `Request failed (${res.status})`);
        }

        const content = data.content || [];
        setLastDebug(content);
        setTurns((prev) => [...prev, { role: "assistant", blocks: content }]);
      } catch (err) {
        setErrorBanner(err.message || "Something went wrong talking to the agent.");
      } finally {
        setLoading(false);
      }
    },
    [turns, loading]
  );

  function handleSubmit(e) {
    e.preventDefault();
    sendToAgent(input);
  }

  function handleCheckoutSubmit(details) {
    setCheckoutOpen(false);
    const cartLines = cart
      .map((i) => `- ${i.qty} × ${i.name} (product_id: ${i.id})`)
      .join("\n");
    const msg = `Please check delivery and then create a guest checkout order (kapruka_create_order) for my cart:
${cartLines}

Recipient: ${details.recipientName}, ${details.recipientPhone}
Delivery address: ${details.address}, ${details.city}
Delivery date: ${details.date}
Sender: ${details.senderName}, ${details.senderPhone}
Gift message: ${details.giftMessage ? `"${details.giftMessage}"` : "(none)"}
Currency: ${details.currency}`;
    sendToAgent(msg, `Checkout — ${cart.length} item${cart.length === 1 ? "" : "s"}, deliver to ${details.city}`);
  }

  const suggestions = [
    { icon: Gift, label: "Gift ideas under Rs 3,000" },
    { icon: Truck, label: "Send flowers to Kandy tomorrow" },
    { icon: Package, label: "Track my order" },
  ];

  return (
    <div className="kap-root">
      <style>{CSS}</style>

      {/* header */}
      <header className="kap-header">
        <div className="kap-brand">
          <div className="kap-brand-mark">
            <Leaf size={18} strokeWidth={2.2} />
          </div>
          <div>
            <div className="kap-brand-name">Kapu</div>
            <div className="kap-brand-sub">shopping assistant · kapruka.com</div>
          </div>
        </div>
        <div className="kap-header-actions">
          <button
            className={`kap-icon-btn ${debugOpen ? "kap-icon-btn-active" : ""}`}
            title="Debug: show raw tool results"
            onClick={() => setDebugOpen((v) => !v)}
          >
            <Bug size={16} />
          </button>
          <button className="kap-cart-btn" onClick={() => setCartOpen(true)}>
            <ShoppingBag size={17} strokeWidth={2.2} />
            <span>Cart</span>
            {cartCount > 0 && <span className="kap-cart-badge">{cartCount}</span>}
          </button>
        </div>
      </header>

      {/* chat scroll area */}
      <main className="kap-chat" ref={scrollRef}>
        <div className="kap-chat-inner">
          {turns.map((t, i) => (
            <Turn
              key={i}
              turn={t}
              onAddToCart={addToCart}
              onCategoryClick={(name) => sendToAgent(`Show me your best products in the "${name}" category`)}
            />
          ))}

          {loading && (
            <div className="kap-turn kap-turn-assistant">
              <div className="kap-bubble kap-bubble-assistant kap-bubble-loading">
                <Loader2 size={15} className="kap-spin" />
                <span>Kapu is checking the catalog…</span>
              </div>
            </div>
          )}

          {errorBanner && (
            <div className="kap-error-banner">
              <strong>Couldn't reach the agent.</strong> {errorBanner}
            </div>
          )}

          {debugOpen && lastDebug && (
            <div className="kap-debug">
              <div className="kap-debug-title">Raw content blocks — last turn</div>
              <pre>{JSON.stringify(lastDebug, null, 2)}</pre>
            </div>
          )}
        </div>
      </main>

      {/* suggestions (only before first real user message) */}
      {turns.length === 1 && (
        <div className="kap-suggestions">
          {suggestions.map((s, i) => (
            <button key={i} className="kap-chip" onClick={() => sendToAgent(s.label)}>
              <s.icon size={13} />
              {s.label}
            </button>
          ))}
        </div>
      )}

      {/* composer */}
      <form className="kap-composer" onSubmit={handleSubmit}>
        <input
          className="kap-input"
          placeholder="Ask for anything on Kapruka… (Sinhala / Tamil / English all work)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
        />
        <button className="kap-send-btn" type="submit" disabled={loading || !input.trim()}>
          <Send size={16} />
        </button>
      </form>

      {/* cart drawer */}
      <CartDrawer
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        cart={cart}
        subtotal={cartSubtotal}
        currency={cartCurrency}
        onUpdateQty={updateQty}
        onRemove={removeFromCart}
        onCheckout={() => {
          setCartOpen(false);
          setCheckoutOpen(true);
        }}
      />

      {/* checkout modal */}
      {checkoutOpen && (
        <CheckoutModal
          cart={cart}
          subtotal={cartSubtotal}
          currency={cartCurrency}
          onClose={() => setCheckoutOpen(false)}
          onSubmit={handleCheckoutSubmit}
        />
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */

function Turn({ turn, onAddToCart, onCategoryClick }) {
  if (turn.role === "user") {
    const text = turn.blocks.find((b) => b.type === "text")?.text || "";
    return (
      <div className="kap-turn kap-turn-user">
        <div className="kap-bubble kap-bubble-user">{turn.displayLabel || text}</div>
      </div>
    );
  }

  // assistant: interleave text blocks and tool-result cards, in order
  const els = [];
  let pendingToolName = null;

  turn.blocks.forEach((block, i) => {
    if (block.type === "text" && block.text?.trim()) {
      els.push(
        <div className="kap-turn kap-turn-assistant" key={`t${i}`}>
          <div className="kap-bubble kap-bubble-assistant">
            <LiteMarkdown text={block.text} />
          </div>
        </div>
      );
    } else if (block.type === "mcp_tool_use") {
      pendingToolName = block.name;
    } else if (block.type === "mcp_tool_result") {
      const parsed = parseToolResult(pendingToolName, block.content, block.is_error);
      els.push(
        <div className="kap-turn kap-turn-assistant kap-turn-card" key={`r${i}`}>
          <ToolResultCard toolName={pendingToolName} parsed={parsed} onAddToCart={onAddToCart} onCategoryClick={onCategoryClick} />
        </div>
      );
    }
  });

  return <>{els}</>;
}

function ToolResultCard({ toolName, parsed, onAddToCart, onCategoryClick }) {
  if (parsed.kind === "error") {
    return (
      <div className="kap-card kap-card-error">
        <strong>That didn't work.</strong>
        <p>{parsed.message}</p>
      </div>
    );
  }

  if (parsed.kind === "products") {
    if (parsed.products.length === 0) {
      return (
        <div className="kap-card kap-card-empty">
          <Search size={16} />
          <span>No matches — try a different keyword or category.</span>
        </div>
      );
    }
    return (
      <div className="kap-product-row">
        {parsed.products.map((p) => (
          <ProductCard key={p.id} product={p} onAddToCart={onAddToCart} />
        ))}
      </div>
    );
  }

  if (parsed.kind === "categories") {
    return (
      <div className="kap-category-grid">
        {parsed.categories.map((c, i) => {
          const name = pick(c, ["name", "title"], String(c));
          const url = pick(c, ["url", "link"], null);
          return (
            <button
              className="kap-category-tile"
              key={i}
              onClick={() => onCategoryClick && onCategoryClick(name)}
              title={url ? `Browse ${name}` : name}
            >
              <span className="kap-category-emoji">{guessCategoryIcon(name)}</span>
              <span className="kap-category-name">{name}</span>
            </button>
          );
        })}
      </div>
    );
  }

  if (parsed.kind === "cities") {
    return (
      <div className="kap-card kap-card-categories">
        {parsed.cities.map((c, i) => (
          <span className="kap-tag" key={i}>
            <MapPin size={11} /> {pick(c, ["name", "city"], String(c))}
          </span>
        ))}
      </div>
    );
  }

  if (parsed.kind === "delivery") {
    return (
      <div className={`kap-card kap-delivery-card ${parsed.deliverable ? "" : "kap-delivery-no"}`}>
        <Truck size={18} />
        <div>
          <div className="kap-delivery-headline">
            {parsed.deliverable ? "Deliverable" : "Not deliverable"}
            {parsed.city ? ` to ${parsed.city}` : ""} {parsed.date ? `on ${parsed.date}` : ""}
          </div>
          {parsed.rate !== null && (
            <div className="kap-delivery-rate">{formatMoney(parsed.rate, parsed.currency)} delivery</div>
          )}
          {parsed.perishable && <div className="kap-delivery-warning">⚠ {String(parsed.perishable)}</div>}
        </div>
      </div>
    );
  }

  if (parsed.kind === "order") {
    return <OrderStampCard order={parsed} />;
  }

  if (parsed.kind === "tracking") {
    return <TrackingCard tracking={parsed} />;
  }

  // raw fallback
  return (
    <div className="kap-card kap-card-raw">
      <LiteMarkdown text={parsed.text} />
    </div>
  );
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

const CARD_GRADIENTS = [
  "linear-gradient(135deg, #14432A, #1E5C3A)",
  "linear-gradient(135deg, #E7A339, #D88F22)",
  "linear-gradient(135deg, #E1636B, #C94952)",
  "linear-gradient(135deg, #1E5C3A, #E7A339)",
];

function ProductCard({ product, onAddToCart }) {
  const priceLabel = formatMoney(product.price, product.currency);
  const gradient = CARD_GRADIENTS[hashString(product.id) % CARD_GRADIENTS.length];

  return (
    <div className="kap-product-card">
      <a
        className="kap-product-link"
        href={product.url || undefined}
        target="_blank"
        rel="noreferrer"
        title={product.url ? "View on Kapruka.com" : product.name}
      >
        <div className="kap-product-img-wrap" style={{ background: product.image ? undefined : gradient }}>
          {product.image ? (
            <img src={product.image} alt={product.name} className="kap-product-img" />
          ) : (
            <div className="kap-product-img-fallback">
              <span className="kap-product-emoji">{guessEmoji(product.name)}</span>
            </div>
          )}
          {!product.inStock && <div className="kap-stock-badge kap-stock-out">Out of stock</div>}
          {product.inStock && product.lowStock && <div className="kap-stock-badge kap-stock-low">Low stock</div>}
          {product.url && (
            <div className="kap-product-view-hint">
              <ExternalLink size={12} /> View
            </div>
          )}
        </div>
        <div className="kap-product-name">{product.name}</div>
      </a>
      <div className="kap-product-body">
        {priceLabel && <div className="kap-product-price">{priceLabel}</div>}
        <button
          className="kap-add-btn"
          disabled={!product.inStock}
          onClick={() => onAddToCart(product)}
        >
          <Plus size={13} /> Add to cart
        </button>
      </div>
    </div>
  );
}

function OrderStampCard({ order }) {
  return (
    <div className="kap-card kap-order-card">
      <div className="kap-stamp">
        <div className="kap-stamp-ring">
          <span>ORDER</span>
          <span>PLACED</span>
        </div>
      </div>
      <div className="kap-order-body">
        <div className="kap-order-number">
          {order.orderNumber ? `Order #${order.orderNumber}` : "Order created"}
        </div>
        <div className="kap-order-status">{order.status}</div>
        {order.total !== null && (
          <div className="kap-order-total">{formatMoney(order.total, order.currency)}</div>
        )}
        {order.expiresAt && (
          <div className="kap-order-expiry">Price locked until {order.expiresAt}</div>
        )}
        {order.payUrl && (
          <a href={order.payUrl} target="_blank" rel="noreferrer" className="kap-pay-btn">
            Pay now <ExternalLink size={14} />
          </a>
        )}
      </div>
    </div>
  );
}

function TrackingCard({ tracking }) {
  return (
    <div className="kap-card kap-tracking-card">
      <div className="kap-tracking-header">
        <Package size={16} />
        <span>{tracking.orderNumber ? `Order #${tracking.orderNumber}` : "Order status"}</span>
        <span className="kap-tracking-status">{tracking.status}</span>
      </div>
      {tracking.events?.length > 0 && (
        <div className="kap-timeline">
          {tracking.events.map((e, i) => (
            <div className="kap-timeline-row" key={i}>
              <div className={`kap-timeline-dot ${i === 0 ? "kap-timeline-dot-active" : ""}`} />
              <div>
                <div className="kap-timeline-status">
                  {pick(e, ["status", "title", "description"], "Update")}
                </div>
                <div className="kap-timeline-time">{pick(e, ["timestamp", "time", "date"], "")}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- cart drawer ---------- */

function CartDrawer({ open, onClose, cart, subtotal, currency, onUpdateQty, onRemove, onCheckout }) {
  return (
    <>
      <div className={`kap-scrim ${open ? "kap-scrim-visible" : ""}`} onClick={onClose} />
      <aside className={`kap-drawer ${open ? "kap-drawer-open" : ""}`}>
        <div className="kap-drawer-header">
          <div className="kap-drawer-title">
            <ShoppingBag size={16} /> Your cart
          </div>
          <button className="kap-icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {cart.length === 0 ? (
          <div className="kap-cart-empty">
            <Gift size={26} />
            <p>Nothing here yet — ask Kapu to find something nice.</p>
          </div>
        ) : (
          <>
            <div className="kap-cart-list">
              {cart.map((item) => (
                <div className="kap-cart-item" key={item.id}>
                  <div className="kap-cart-item-img">
                    {item.image ? (
                      <img src={item.image} alt={item.name} />
                    ) : (
                      <Gift size={16} />
                    )}
                  </div>
                  <div className="kap-cart-item-body">
                    <div className="kap-cart-item-name">{item.name}</div>
                    <div className="kap-cart-item-price">{formatMoney(item.price, item.currency)}</div>
                    <div className="kap-qty-control">
                      <button onClick={() => onUpdateQty(item.id, -1)}>
                        <Minus size={12} />
                      </button>
                      <span>{item.qty}</span>
                      <button onClick={() => onUpdateQty(item.id, 1)}>
                        <Plus size={12} />
                      </button>
                      <button className="kap-remove-btn" onClick={() => onRemove(item.id)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="kap-drawer-footer">
              <div className="kap-subtotal-row">
                <span>Subtotal</span>
                <span>{formatMoney(subtotal, currency)}</span>
              </div>
              <button className="kap-checkout-btn" onClick={onCheckout}>
                Checkout <ChevronDown size={14} style={{ transform: "rotate(-90deg)" }} />
              </button>
            </div>
          </>
        )}
      </aside>
    </>
  );
}

/* ---------- checkout modal ---------- */

function CheckoutModal({ cart, subtotal, currency, onClose, onSubmit }) {
  const [form, setForm] = useState({
    recipientName: "",
    recipientPhone: "",
    address: "",
    city: "",
    date: "",
    senderName: "",
    senderPhone: "",
    giftMessage: "",
    currency: currency || "LKR",
  });

  function set(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  const valid =
    form.recipientName && form.recipientPhone && form.address && form.city && form.date;

  return (
    <>
      <div className="kap-scrim kap-scrim-visible" onClick={onClose} />
      <div className="kap-modal">
        <div className="kap-modal-header">
          <div className="kap-drawer-title">
            <Gift size={16} /> Guest checkout
          </div>
          <button className="kap-icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="kap-modal-body">
          <div className="kap-modal-summary">
            {cart.length} item{cart.length === 1 ? "" : "s"} · {formatMoney(subtotal, currency)}
          </div>

          <div className="kap-form-section">Recipient</div>
          <div className="kap-form-row">
            <input placeholder="Recipient name" value={form.recipientName} onChange={(e) => set("recipientName", e.target.value)} />
            <input placeholder="Recipient phone" value={form.recipientPhone} onChange={(e) => set("recipientPhone", e.target.value)} />
          </div>
          <input className="kap-form-full" placeholder="Delivery address" value={form.address} onChange={(e) => set("address", e.target.value)} />
          <div className="kap-form-row">
            <input placeholder="City" value={form.city} onChange={(e) => set("city", e.target.value)} />
            <input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} />
          </div>

          <div className="kap-form-section">Sender</div>
          <div className="kap-form-row">
            <input placeholder="Your name" value={form.senderName} onChange={(e) => set("senderName", e.target.value)} />
            <input placeholder="Your phone" value={form.senderPhone} onChange={(e) => set("senderPhone", e.target.value)} />
          </div>

          <div className="kap-form-section">
            <Sparkles size={12} /> Gift message (optional)
          </div>
          <textarea
            className="kap-form-full"
            rows={2}
            placeholder="e.g. Happy Avurudu, malli! From all of us."
            value={form.giftMessage}
            onChange={(e) => set("giftMessage", e.target.value)}
          />
        </div>

        <div className="kap-modal-footer">
          <button
            className="kap-checkout-btn"
            disabled={!valid}
            onClick={() => onSubmit(form)}
          >
            Confirm & get pay link
          </button>
        </div>
      </div>
    </>
  );
}

/* ---------- Search icon isn't imported above the fold in some builds ---------- */
function Search(props) {
  return (
    <svg width={props.size || 16} height={props.size || 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

/* ────────────────────────────────────────────────────────────────────── */

const CSS = `
:root {
  --kap-bg: #FBF6EC;
  --kap-ink: #16241C;
  --kap-primary: #14432A;
  --kap-primary-light: #1E5C3A;
  --kap-accent: #E7A339;
  --kap-coral: #E1636B;
  --kap-line: #E4DCC8;
  --kap-card: #FFFFFF;
}

.kap-root {
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  background: var(--kap-bg);
  color: var(--kap-ink);
  font-family: 'Inter', sans-serif;
  position: relative;
  overflow: hidden;
}

/* header */
.kap-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  background: var(--kap-primary);
  color: #F6EFDD;
  flex-shrink: 0;
}
.kap-brand { display: flex; align-items: center; gap: 10px; }
.kap-brand-mark {
  width: 34px; height: 34px; border-radius: 50%;
  background: var(--kap-accent);
  color: var(--kap-primary);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.kap-brand-name { font-family: 'Fraunces', serif; font-weight: 700; font-size: 17px; line-height: 1.1; letter-spacing: 0.2px; }
.kap-brand-sub { font-size: 10.5px; opacity: 0.68; letter-spacing: 0.3px; margin-top: 1px; }
.kap-header-actions { display: flex; align-items: center; gap: 8px; }
.kap-icon-btn {
  width: 32px; height: 32px; border-radius: 50%;
  border: 1px solid rgba(246,239,221,0.25);
  background: transparent; color: #F6EFDD;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
}
.kap-icon-btn-active { background: var(--kap-accent); color: var(--kap-primary); border-color: var(--kap-accent); }
.kap-cart-btn {
  display: flex; align-items: center; gap: 6px;
  background: var(--kap-accent); color: var(--kap-primary);
  border: none; border-radius: 20px; padding: 7px 14px 7px 12px;
  font-weight: 600; font-size: 13px; cursor: pointer; position: relative;
}
.kap-cart-badge {
  position: absolute; top: -6px; right: -6px;
  background: var(--kap-coral); color: white;
  font-size: 10px; font-weight: 700;
  min-width: 17px; height: 17px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-family: 'IBM Plex Mono', monospace;
}

/* chat */
.kap-chat { flex: 1; overflow-y: auto; }
.kap-chat-inner { max-width: 640px; margin: 0 auto; padding: 20px 16px 8px; display: flex; flex-direction: column; }
.kap-turn { display: flex; margin-bottom: 10px; }
.kap-turn-user { justify-content: flex-end; }
.kap-turn-assistant { justify-content: flex-start; }
.kap-turn-card { margin-bottom: 4px; }

.kap-bubble { max-width: 82%; padding: 10px 14px; border-radius: 16px; font-size: 14.5px; line-height: 1.5; }
.kap-bubble-user { background: var(--kap-primary); color: #F6EFDD; border-bottom-right-radius: 4px; }
.kap-bubble-assistant { background: var(--kap-card); border: 1px solid var(--kap-line); border-bottom-left-radius: 4px; }
.kap-bubble-loading { display: flex; align-items: center; gap: 8px; color: #6b6252; font-size: 13px; }
.kap-spin { animation: kap-spin 1s linear infinite; }
@keyframes kap-spin { to { transform: rotate(360deg); } }

.lite-md p { margin: 0 0 6px; }
.lite-md p:last-child { margin-bottom: 0; }
.lite-md-bullet { display: flex; gap: 8px; margin-bottom: 4px; align-items: flex-start; }
.lite-md-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--kap-accent); margin-top: 8px; flex-shrink: 0; }

/* cards */
.kap-card { background: var(--kap-card); border: 1px solid var(--kap-line); border-radius: 14px; padding: 12px 14px; max-width: 82%; font-size: 13.5px; }
.kap-card-error { border-color: #e8b4b4; background: #FCEFEF; color: #8a2f2f; }
.kap-card-empty { display: flex; align-items: center; gap: 8px; color: #6b6252; }
.kap-card-raw { white-space: pre-wrap; font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #4a4438; }
.kap-card-categories { display: flex; flex-wrap: wrap; gap: 6px; }
.kap-tag { display: inline-flex; align-items: center; gap: 4px; background: #F1ECDC; border: 1px solid var(--kap-line); padding: 4px 10px; border-radius: 20px; font-size: 12px; }

/* category grid — clickable, icon + label, scrolls if long */
.kap-category-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 6px; max-width: 90%; max-height: 230px; overflow-y: auto;
  padding: 4px; background: var(--kap-card); border: 1px solid var(--kap-line); border-radius: 14px;
}
.kap-category-tile {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  background: #FBF6EC; border: 1px solid var(--kap-line); border-radius: 10px;
  padding: 10px 6px; cursor: pointer; font-family: 'Inter', sans-serif;
}
.kap-category-tile:hover { border-color: var(--kap-accent); background: #F6EFDD; }
.kap-category-emoji { font-size: 18px; }
.kap-category-name { font-size: 10.5px; font-weight: 600; text-align: center; line-height: 1.25; color: var(--kap-ink); }

/* product cards */
.kap-product-row { display: flex; gap: 10px; overflow-x: auto; padding: 2px 2px 8px; max-width: 100%; }
.kap-product-card {
  flex-shrink: 0; width: 150px; background: var(--kap-card);
  border: 1px solid var(--kap-line); border-radius: 14px; overflow: hidden;
  display: flex; flex-direction: column;
}
.kap-product-link { display: block; text-decoration: none; color: inherit; }
.kap-product-img-wrap { position: relative; width: 100%; height: 100px; background: #F1ECDC; }
.kap-product-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.kap-product-img-fallback { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
.kap-product-emoji { font-size: 30px; }
.kap-stock-badge { position: absolute; bottom: 6px; left: 6px; font-size: 9.5px; padding: 2px 7px; border-radius: 10px; font-weight: 600; }
.kap-stock-out { background: rgba(22,36,28,0.85); color: white; }
.kap-stock-low { background: var(--kap-accent); color: var(--kap-primary); }
.kap-product-view-hint {
  position: absolute; top: 6px; right: 6px; display: flex; align-items: center; gap: 3px;
  background: rgba(255,255,255,0.92); color: var(--kap-primary); font-size: 9.5px; font-weight: 700;
  padding: 3px 7px; border-radius: 10px; opacity: 0; transition: opacity 0.15s;
}
.kap-product-card:hover .kap-product-view-hint { opacity: 1; }
.kap-product-name { font-size: 12.5px; font-weight: 600; line-height: 1.3; padding: 8px 10px 0; min-height: 30px; }
.kap-product-body { padding: 6px 10px 10px; display: flex; flex-direction: column; gap: 6px; }
.kap-product-price { font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; color: var(--kap-primary); font-weight: 700; }
.kap-add-btn { display: flex; align-items: center; justify-content: center; gap: 4px; background: var(--kap-primary); color: #F6EFDD; border: none; border-radius: 20px; padding: 7px 0; font-size: 11.5px; font-weight: 600; cursor: pointer; width: 100%; }
.kap-add-btn:disabled { background: #cfc9b8; cursor: not-allowed; }


/* delivery card */
.kap-delivery-card { display: flex; gap: 10px; align-items: flex-start; border-left: 3px solid var(--kap-primary); }
.kap-delivery-no { border-left-color: var(--kap-coral); }
.kap-delivery-headline { font-weight: 600; }
.kap-delivery-rate { color: #6b6252; margin-top: 2px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; }
.kap-delivery-warning { color: var(--kap-coral); margin-top: 4px; font-size: 12.5px; }

/* order confirmation — stamp signature element */
.kap-order-card { display: flex; gap: 14px; align-items: center; background: #FFFDF7; }
.kap-stamp { flex-shrink: 0; }
.kap-stamp-ring {
  width: 62px; height: 62px; border-radius: 50%;
  border: 2px dashed var(--kap-coral);
  color: var(--kap-coral);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  transform: rotate(-8deg);
  font-family: 'IBM Plex Mono', monospace; font-size: 8.5px; font-weight: 700; letter-spacing: 0.5px;
}
.kap-order-number { font-family: 'Fraunces', serif; font-weight: 700; font-size: 15px; }
.kap-order-status { color: #6b6252; font-size: 12px; text-transform: capitalize; margin-top: 1px; }
.kap-order-total { font-family: 'IBM Plex Mono', monospace; font-weight: 600; margin-top: 4px; }
.kap-order-expiry { font-size: 11px; color: #8a8168; margin-top: 2px; }
.kap-pay-btn { display: inline-flex; align-items: center; gap: 6px; margin-top: 8px; background: var(--kap-accent); color: var(--kap-primary); text-decoration: none; padding: 7px 14px; border-radius: 20px; font-weight: 700; font-size: 12.5px; }

/* tracking */
.kap-tracking-card { max-width: 90%; }
.kap-tracking-header { display: flex; align-items: center; gap: 8px; font-weight: 600; margin-bottom: 10px; }
.kap-tracking-status { margin-left: auto; background: #F1ECDC; padding: 2px 10px; border-radius: 12px; font-size: 11px; text-transform: capitalize; }
.kap-timeline { display: flex; flex-direction: column; gap: 10px; padding-left: 4px; }
.kap-timeline-row { display: flex; gap: 10px; }
.kap-timeline-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--kap-line); margin-top: 4px; flex-shrink: 0; }
.kap-timeline-dot-active { background: var(--kap-primary); }
.kap-timeline-status { font-size: 12.5px; font-weight: 600; }
.kap-timeline-time { font-size: 11px; color: #8a8168; font-family: 'IBM Plex Mono', monospace; }

/* error / debug */
.kap-error-banner { max-width: 82%; background: #FCEFEF; border: 1px solid #e8b4b4; color: #8a2f2f; padding: 10px 14px; border-radius: 12px; font-size: 13px; margin-bottom: 10px; }
.kap-debug { background: #16241C; color: #B7EACB; border-radius: 12px; padding: 12px; margin-top: 8px; max-height: 220px; overflow: auto; }
.kap-debug-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.6; margin-bottom: 6px; }
.kap-debug pre { font-size: 11px; font-family: 'IBM Plex Mono', monospace; white-space: pre-wrap; margin: 0; }

/* suggestions */
.kap-suggestions { display: flex; gap: 8px; padding: 0 16px 10px; max-width: 640px; margin: 0 auto; width: 100%; flex-wrap: wrap; }
.kap-chip { display: flex; align-items: center; gap: 6px; background: var(--kap-card); border: 1px solid var(--kap-line); padding: 7px 13px; border-radius: 20px; font-size: 12.5px; cursor: pointer; color: var(--kap-ink); }
.kap-chip:hover { border-color: var(--kap-accent); }

/* composer */
.kap-composer { display: flex; gap: 8px; padding: 12px 16px 16px; max-width: 640px; margin: 0 auto; width: 100%; flex-shrink: 0; }
.kap-input { flex: 1; border: 1px solid var(--kap-line); background: var(--kap-card); border-radius: 24px; padding: 12px 16px; font-size: 14px; outline: none; font-family: 'Inter', sans-serif; }
.kap-input:focus { border-color: var(--kap-accent); }
.kap-send-btn { width: 44px; height: 44px; border-radius: 50%; background: var(--kap-primary); color: #F6EFDD; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; }
.kap-send-btn:disabled { background: #cfc9b8; cursor: not-allowed; }

/* scrim + drawer */
.kap-scrim { position: absolute; inset: 0; background: rgba(22,36,28,0.35); opacity: 0; pointer-events: none; transition: opacity 0.2s; z-index: 20; }
.kap-scrim-visible { opacity: 1; pointer-events: auto; }
.kap-drawer {
  position: absolute; top: 0; right: 0; bottom: 0; width: 320px; max-width: 88%;
  background: var(--kap-bg); border-left: 1px solid var(--kap-line);
  display: flex; flex-direction: column;
  transform: translateX(100%); transition: transform 0.25s ease; z-index: 21;
}
.kap-drawer-open { transform: translateX(0); }
.kap-drawer-header { display: flex; align-items: center; justify-content: space-between; padding: 16px; border-bottom: 1px solid var(--kap-line); }
.kap-drawer-title { display: flex; align-items: center; gap: 8px; font-family: 'Fraunces', serif; font-weight: 700; font-size: 15px; }
.kap-cart-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #8a8168; text-align: center; padding: 0 30px; font-size: 13px; }
.kap-cart-list { flex: 1; overflow-y: auto; padding: 10px 16px; display: flex; flex-direction: column; gap: 12px; }
.kap-cart-item { display: flex; gap: 10px; }
.kap-cart-item-img { width: 48px; height: 48px; border-radius: 10px; background: #F1ECDC; flex-shrink: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; color: #b9ae94; }
.kap-cart-item-img img { width: 100%; height: 100%; object-fit: cover; }
.kap-cart-item-name { font-size: 13px; font-weight: 600; line-height: 1.3; }
.kap-cart-item-price { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: var(--kap-primary); margin-top: 1px; }
.kap-qty-control { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.kap-qty-control button { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--kap-line); background: white; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.kap-qty-control span { font-size: 12px; font-weight: 600; min-width: 14px; text-align: center; }
.kap-remove-btn { margin-left: auto; border: none !important; color: var(--kap-coral); background: none; }
.kap-drawer-footer { padding: 14px 16px 18px; border-top: 1px solid var(--kap-line); }
.kap-subtotal-row { display: flex; justify-content: space-between; font-size: 13.5px; margin-bottom: 10px; }
.kap-subtotal-row span:last-child { font-family: 'IBM Plex Mono', monospace; font-weight: 600; }
.kap-checkout-btn { width: 100%; background: var(--kap-accent); color: var(--kap-primary); border: none; border-radius: 24px; padding: 12px; font-weight: 700; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; }
.kap-checkout-btn:disabled { background: #cfc9b8; cursor: not-allowed; }

/* modal */
.kap-modal {
  position: absolute; top: 4%; left: 50%; transform: translateX(-50%);
  width: 380px; max-width: 90%; max-height: 92%;
  background: var(--kap-bg); border: 1px solid var(--kap-line); border-radius: 18px;
  display: flex; flex-direction: column; z-index: 22; overflow: hidden;
  box-shadow: 0 20px 60px rgba(22,36,28,0.25);
}
.kap-modal-header { display: flex; align-items: center; justify-content: space-between; padding: 16px; border-bottom: 1px solid var(--kap-line); }
.kap-modal-body { padding: 14px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.kap-modal-summary { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #6b6252; background: #F1ECDC; padding: 7px 10px; border-radius: 8px; margin-bottom: 4px; }
.kap-form-section { display: flex; align-items: center; gap: 5px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #8a8168; margin-top: 8px; font-weight: 600; }
.kap-form-row { display: flex; gap: 8px; }
.kap-form-row input, .kap-form-full { border: 1px solid var(--kap-line); background: white; border-radius: 10px; padding: 9px 11px; font-size: 13px; font-family: 'Inter', sans-serif; outline: none; width: 100%; }
.kap-form-row input:focus, .kap-form-full:focus { border-color: var(--kap-accent); }
textarea.kap-form-full { resize: vertical; }
.kap-modal-footer { padding: 12px 16px 16px; border-top: 1px solid var(--kap-line); }
`;
