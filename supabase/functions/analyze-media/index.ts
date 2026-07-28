// supabase/functions/analyze-media/index.ts
//
// Analyzes a single pending media row (a photo) with Claude and stores a
// suggested categorization on it. Runs under the CALLING USER's own JWT
// (forwarded automatically by supabase-js's functions.invoke), not a
// service-role admin client - the same RLS/storage policies that gate the
// rest of the app apply here, so there's no privilege escalation to
// reason about.
//
// Does NOT create or attach a chapter - it only writes suggestions onto
// the media row. Turning a suggestion into a saved chapter is the job of
// the review/confirm UI (houstory-96t.4).

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

const CATEGORIZE_TOOL = {
  name: "categorize_photo",
  description: "Categorize and describe a home photo for the Houstory app.",
  input_schema: {
    type: "object",
    properties: {
      chapter_type: {
        type: "string",
        enum: ["renovation", "landscaping", "paint", "appliance", "research", "general"],
        description: "Best-fit category for this photo.",
      },
      title: {
        type: "string",
        description: "A short chapter title, e.g. 'Kitchen Cabinet Repaint'.",
      },
      description: {
        type: "string",
        description: "1-3 sentence natural-language description of what's in the photo.",
      },
      fields: {
        type: "object",
        description:
          "Type-specific structured fields when identifiable. paint: brand, color_name, color_code, hex, sheen, room. appliance: brand, model_number, serial_number. Omit fields you can't confidently read from the photo.",
      },
    },
    required: ["chapter_type", "title", "description"],
  },
};

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

  const { media_id } = payload ?? {};
  if (!media_id) return err("media_id is required");

  const { data: media, error: mediaErr } = await sb
    .from("media")
    .select("id, storage_path, caption, kind")
    .eq("id", media_id)
    .single();

  if (mediaErr || !media) return err("media not found or not accessible", 404);
  if (media.kind !== "photo") return err("only photo analysis is supported right now", 400);
  if (!media.storage_path) return err("media has no storage_path", 400);

  const { data: fileBlob, error: dlErr } = await sb.storage
    .from("houstory-media")
    .download(media.storage_path);

  if (dlErr || !fileBlob) return err(`failed to download media: ${dlErr?.message ?? "unknown error"}`, 500);

  const arrayBuffer = await fileBlob.arrayBuffer();
  const base64 = encodeBase64(new Uint8Array(arrayBuffer));
  const mediaType = fileBlob.type || "image/jpeg";

  const userNote = media.caption
    ? `The user attached this note when uploading: "${media.caption}"`
    : "No additional note was provided.";

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      tools: [CATEGORIZE_TOOL],
      tool_choice: { type: "tool", name: "categorize_photo" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            {
              type: "text",
              text:
                "This photo is for Houstory, an app for tracking a home's renovations, landscaping, paint colors, appliances, and history. " +
                userNote +
                " Categorize this photo.",
            },
          ],
        },
      ],
    }),
  });

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return err(`Claude API error: ${errText}`, 502);
  }

  const anthropicData = await anthropicRes.json();
  const toolUse = (anthropicData.content ?? []).find((b: any) => b.type === "tool_use");
  if (!toolUse) return err("Claude did not return a categorization", 502);

  const suggestion = toolUse.input;

  const { error: updateErr } = await sb
    .from("media")
    .update({
      ai_description: suggestion.description,
      ai_extracted: { suggested: suggestion },
    })
    .eq("id", media_id);

  if (updateErr) return err(`Failed to save analysis: ${updateErr.message}`, 500);

  return json({ status: "ok", suggestion });
});
