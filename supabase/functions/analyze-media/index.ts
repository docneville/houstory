// supabase/functions/analyze-media/index.ts
//
// Freeform analysis (houstory-96t.23): takes 1+ media rows and a user-
// written instructions string, sends the photo(s) + instructions to Claude
// with no forced tool schema, and stores Claude's raw text response on
// every media row involved (shared ai_description). Deliberately NOT
// trying to extract structured chapter_type/title/fields anymore - that
// forced categorization got in the way of just tuning what Claude is
// asked to look for. Runs under the CALLING USER's own JWT (forwarded by
// the client), not a service-role admin client - same RLS/storage
// policies as everywhere else.
//
// Does NOT create or attach a chapter - filing an analyzed photo into a
// chapter is a separate, later step (chapter.html's "add existing
// photos" picker).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

const DEFAULT_INSTRUCTIONS =
  "Describe what's in this photo and call out any useful details you can make out - brand, model/serial numbers, color, condition, text on labels, anything a homeowner might want on record.";

// houstory-96t.6: without web search, Claude can only describe a plausible
// way to find something ("check the manufacturer's Support page") since it
// has no way to fetch or verify a real URL. This system prompt doesn't
// override the user's own instructions (that's still the whole point of
// houstory-96t.23's freeform pivot) - it just tells Claude the tool exists
// and to prefer concrete results over descriptions of a search strategy.
const SYSTEM_PROMPT =
  "You are helping analyze a photo for Houstory, an app for tracking a home's renovations, landscaping, paint colors, appliances, and history. " +
  "You have a web_search tool available. When the user's instructions call for it - e.g. finding a product's manual, a retailer's contact info, " +
  "warranty/recall info, or local repair services for a brand/model you've identified - use it and give concrete results: actual links, " +
  "business names, addresses, phone numbers. Don't just describe how someone could search for these themselves. If the instructions don't call " +
  "for a lookup, don't force a search.";

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return err("Missing Authorization header", 401);

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return err("Invalid JSON body");
  }

  const media_ids: string[] = Array.isArray(payload?.media_ids) ? payload.media_ids : [];
  const instructions: string = (payload?.instructions || "").trim() || DEFAULT_INSTRUCTIONS;

  if (media_ids.length === 0) return err("media_ids is required (array of at least one id)");

  const { data: mediaRows, error: mediaErr } = await sb
    .from("media")
    .select("id, storage_path, kind")
    .in("id", media_ids);

  if (mediaErr || !mediaRows || mediaRows.length !== media_ids.length) {
    return err("one or more media items not found or not accessible", 404);
  }

  // Preserve the client's ordering - not load-bearing for correctness here
  // (there's no per-image title to line up anymore), but keeps images sent
  // to Claude in the order the user picked them.
  const byId = new Map(mediaRows.map((m: any) => [m.id, m]));
  const orderedMedia = media_ids.map((id) => byId.get(id));

  if (orderedMedia.some((m: any) => m.kind !== "photo" || !m.storage_path)) {
    return err("only photo media with a storage_path can be analyzed", 400);
  }

  const downloads = await Promise.all(
    orderedMedia.map(async (m: any) => {
      const { data: fileBlob, error } = await sb.storage.from("houstory-media").download(m.storage_path);
      if (error || !fileBlob) return null;
      const arrayBuffer = await fileBlob.arrayBuffer();
      return { base64: encodeBase64(new Uint8Array(arrayBuffer)), mediaType: fileBlob.type || "image/jpeg" };
    })
  );

  if (downloads.some((d) => d === null)) return err("failed to download one or more media items", 500);

  const content = [
    ...downloads.map((d) => ({ type: "image", source: { type: "base64", media_type: d!.mediaType, data: d!.base64 } })),
    { type: "text", text: instructions },
  ];

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content }],
    }),
  });

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return err(`Claude API error: ${errText}`, 502);
  }

  const anthropicData = await anthropicRes.json();
  // With web search enabled, the response can interleave server_tool_use /
  // web_search_tool_result blocks between multiple text blocks (a query,
  // then a synthesis, sometimes more than once) - join all text blocks in
  // order rather than assuming the first (or only) one is the whole answer.
  const textBlocks = (anthropicData.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text);
  if (textBlocks.length === 0) return err("Claude did not return a text response", 502);

  const responseText = textBlocks.join("\n\n");

  for (const id of media_ids) {
    const { error: updateErr } = await sb.from("media").update({ ai_description: responseText }).eq("id", id);
    if (updateErr) return err(`Failed to save analysis for ${id}: ${updateErr.message}`, 500);
  }

  return json({ status: "ok", response: responseText });
});
