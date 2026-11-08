// Standalone adapters replacing the Hatch runtime's ctx.tool / ctx.inference
// for the iMac port. No platform keys are involved:
// - web search is DuckDuckGo Lite (no key, plain HTML results). DDG's
//   anomaly block hits this box's IPv6 egress only, so webSearch falls
//   back to curl -4 (forced IPv4) when the first fetch comes back empty.
// - synthesis is the fleet LM Studio endpoint on the Mac Studio
//   (OpenAI-compatible, reachable from the iMac over Tailscale).
import type { z } from "zod";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

// ---------------------------------------------------------------- web search

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  content: { results: SearchResult[]; summary: string };
}

export async function webSearch(query: string): Promise<SearchResponse> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  // Path 1: Bun fetch (happy eyeballs — usually IPv6 first). The iMac's
  // IPv6 egress is anomaly-blocked by DDG (Nov 7: challenge page, 0
  // results, while the same query over IPv4 returns 10). If fetch yields
  // nothing, fall through to curl -4.
  let html = await fetchDdg(url);
  let results = parseDdgLite(html);
  if (results.length > 0) return { content: { results, summary: "" } };
  console.warn(`[search] DDG fetch empty for "${query}" — retrying over IPv4 (curl -4)`);
  html = await fetchDdgCurl4(url);
  results = parseDdgLite(html);
  if (results.length === 0) {
    console.error(`[search] DDG empty on both paths for "${query}" — sweep will see an empty pool`);
  }
  return { content: { results, summary: "" } };
}

async function fetchDdg(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  }
}

// Force IPv4: DDG's anomaly block hits this box's IPv6 address only
// (verified Nov 7: IPv6 -> challenge page, IPv4 -> 10 results).
async function fetchDdgCurl4(url: string): Promise<string> {
  try {
    const proc = Bun.spawn(["curl", "-4", "-s", "--max-time", "25", "-A", UA, url], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return text;
  } catch {
    return "";
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapDdg(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return u.toString();
  } catch {
    return href;
  }
}

export function parseDdgLite(html: string): SearchResult[] {
  // Lite HTML: each result is <a ... class="result-link" href="...">Title</a>
  // followed later by <td class='result-snippet'>Snippet</td>. Pair by order.
  const out: SearchResult[] = [];
  const anchors = [...html.matchAll(/<a[^>]*>[\s\S]*?<\/a>/g)];
  const links: { url: string; title: string }[] = [];
  for (const m of anchors) {
    const tag = m[0];
    if (!tag.includes("result-link")) continue;
    const href = tag.match(/href="([^"]+)"/)?.[1];
    const inner = tag.replace(/<[^>]+>/g, "");
    if (!href) continue;
    const title = stripTags(inner);
    const url = unwrapDdg(href);
    if (title && url.startsWith("http")) links.push({ url, title });
  }
  const snips = [...html.matchAll(/<td class='result-snippet'[^>]*>([\s\S]*?)<\/td>/g)];
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (!link) continue;
    const rawSnippet = snips[i]?.[1];
    const snippet = rawSnippet ? stripTags(rawSnippet) : "";
    out.push({ ...link, snippet });
  }
  return out;
}

// ---------------------------------------------------------------- inference

// JSON Schema mirroring the synthesisSchema in actions.ts (title/hook/type/
// crazyScore/whyShyAway/marketSignal/upsideCase/whyForYou/firstMove/
// sevenDayTest/evidence[{label, value, sourceUrl}]). The zod schema passed
// to inferenceComplete is still the real contract — this wire schema is
// only the shape hint, and the parsed reply is validated with schema.parse.
const SYNTHESIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          hook: { type: "string" },
          type: { type: "string", enum: ["business", "art", "hybrid"] },
          crazyScore: { type: "number", minimum: 1, maximum: 10 },
          whyShyAway: { type: "string" },
          marketSignal: { type: "string" },
          upsideCase: { type: "string" },
          whyForYou: { type: "string" },
          firstMove: { type: "string" },
          sevenDayTest: { type: "string" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                value: { type: "string" },
                sourceUrl: { type: "string" },
              },
              required: ["label", "value", "sourceUrl"],
              additionalProperties: false,
            },
          },
        },
        required: [
          "title",
          "hook",
          "type",
          "crazyScore",
          "whyShyAway",
          "marketSignal",
          "upsideCase",
          "whyForYou",
          "firstMove",
          "sevenDayTest",
          "evidence",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["ideas"],
  additionalProperties: false,
};

function lmConfig(): { baseUrl: string; model: string } {
  return {
    baseUrl:
      process.env.LM_BASE_URL ?? "http://100.70.123.107:1234/v1",
    model:
      process.env.LM_MODEL ??
      "qwen3.6-35b-a3b-uncensored-hauhaucs-aggressive",
  };
}

async function chatOnce(
  baseUrl: string,
  model: string,
  prompt: string,
  useJsonSchema: boolean,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 6000,
    temperature: 0.7,
  };
  body.response_format = useJsonSchema
    ? {
        type: "json_schema",
        json_schema: { name: "synthesis", strict: true, schema: SYNTHESIS_JSON_SCHEMA },
      }
    : { type: "json_object" };
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LM Studio ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LM Studio returned an empty completion");
  return content;
}

export async function inferenceComplete(
  prompt: string,
  opts: { schema: z.ZodTypeAny },
): Promise<unknown> {
  const { baseUrl, model } = lmConfig();
  let content: string;
  try {
    content = await chatOnce(baseUrl, model, prompt, true);
  } catch (err) {
    // Some endpoints reject strict json_schema; fall back to json_object.
    if (err instanceof Error && /400|response_format|json_schema/i.test(err.message)) {
      content = await chatOnce(baseUrl, model, prompt, false);
    } else {
      throw err;
    }
  }
  try {
    return opts.schema.parse(JSON.parse(content));
  } catch {
    // One repair retry: ask for the same JSON again, nothing else.
    const retry = await chatOnce(
      baseUrl,
      model,
      `${prompt}\n\nYour previous reply was not valid JSON matching the requested shape. Reply with ONLY the JSON object, no other text.`,
      true,
    );
    return opts.schema.parse(JSON.parse(retry));
  }
}
