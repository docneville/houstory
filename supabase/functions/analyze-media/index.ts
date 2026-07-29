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
        description:
          "A SHORT label (a few words) for THIS SPECIFIC photo, useful for scanning a grid of many photos at a glance - e.g. 'Front of refrigerator', 'Model/serial sticker', 'Kitchen before demo'. If this photo is one of several views of the same single item (e.g. an appliance's main shot plus its serial sticker), make the title specific enough to distinguish it from those other views.",
      },
      description: {
        type: "string",
        description: "1-3 sentence natural-language description of what's in THIS SPECIFIC photo.",
      },
      suggested_chapter_name: {
        type: "string",
        description:
          "A short, GENERIC name for the broader ongoing chapter/story this photo might belong to if grouped with many similar photos over time - e.g. 'Kitchen Renovation', 'Paint Colors', 'Landscaping', 'Exterior Photos'. This is NOT a caption of this one photo - it's a project/theme name a human would recognize and want to keep adding photos to.",
      },
      fields: {
        type: "object",
        description:
          "Type-specific structured fields when identifiable. paint: brand, color_name, color_code, hex, sheen, room. appliance: brand, model_number, serial_number. Omit fields you can't confidently read from the photo.",
      },
    },
    required: ["chapter_type", "title", "description", "suggested_chapter_name"],
  },
};

// For a GROUP of 2+ photos that are views of the same single item (e.g. an
// appliance's main shot + its serial sticker) - see houstory-96t.15. One
// shared classification/description/fields set, but photo_titles keeps a
// distinguishing title per input image so the grid still reads sensibly.
const CATEGORIZE_GROUP_TOOL = {
  name: "categorize_photo_group",
  description: "Categorize and describe a group of photos that are all views of the SAME single item, for the Houstory app.",
  input_schema: {
    type: "object",
    properties: {
      chapter_type: {
        type: "string",
        enum: ["renovation", "landscaping", "paint", "appliance", "research", "general"],
        description: "Best-fit category for this item, considering all the photos together.",
      },
      description: {
        type: "string",
        description: "1-3 sentence natural-language description of the item, combining what's visible across ALL the photos (e.g. brand seen in one photo, model number seen in another).",
      },
      suggested_chapter_name: {
        type: "string",
        description:
          "A short, GENERIC name for the broader ongoing chapter/story this item might belong to if grouped with many similar photos over time - e.g. 'Kitchen Renovation', 'Paint Colors', 'Kitchen Appliances'. This is NOT a caption of the item - it's a project/theme name a human would recognize and want to keep adding photos to.",
      },
      fields: {
        type: "object",
        description:
          "Type-specific structured fields, merged from whichever photo shows them. paint: brand, color_name, color_code, hex, sheen, room. appliance: brand, model_number, serial_number. Omit fields you can't confidently read from any of the photos.",
      },
      photo_titles: {
        type: "array",
        items: { type: "string" },
        description:
          "One short label per input photo, IN THE SAME ORDER the photos were given, distinguishing what each specific photo shows (e.g. ['Front of refrigerator', 'Model/serial sticker']). Must have exactly one entry per input photo.",
      },
    },
    required: ["chapter_type", "description", "suggested_chapter_name", "photo_titles"],
  },
};

async function downloadAsBase64(sb: any, storagePath: string): Promise<{ base64: string; mediaType: string } | null> {
  const { data: fileBlob, error } = await sb.storage.from("houstory-media").download(storagePath);
  if (error || !fileBlob) return null;
  const arrayBuffer = await fileBlob.arrayBuffer();
  return { base64: encodeBase64(new Uint8Array(arrayBuffer)), mediaType: fileBlob.type || "image/jpeg" };
}

async function callClaude(tool: any, content: any[]) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error: ${await res.text()}`);

  const data = await res.json();
  const toolUse = (data.content ?? []).find((b: any) => b.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return a categorization");
  return toolUse.input;
}

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

  const { media_id, media_ids } = payload ?? {};

  // ---- GROUP path: 2+ photos that are views of the same single item ----
  if (Array.isArray(media_ids) && media_ids.length > 0) {
    const { data: mediaRows, error: mediaErr } = await sb
      .from("media")
      .select("id, storage_path, caption, kind")
      .in("id", media_ids);

    if (mediaErr || !mediaRows || mediaRows.length !== media_ids.length) {
      return err("one or more media items not found or not accessible", 404);
    }

    // Preserve the client's ordering (the .in() query doesn't guarantee it) -
    // photo_titles must line up with the images in the order we send them.
    const byId = new Map(mediaRows.map((m: any) => [m.id, m]));
    const orderedMedia = media_ids.map((id: string) => byId.get(id));

    if (orderedMedia.some((m: any) => m.kind !== "photo" || !m.storage_path)) {
      return err("only photo media with a storage_path can be analyzed", 400);
    }

    const downloads = await Promise.all(orderedMedia.map((m: any) => downloadAsBase64(sb, m.storage_path)));
    if (downloads.some((d) => d === null)) return err("failed to download one or more media items", 500);

    const notes = orderedMedia
      .map((m: any) => m.caption)
      .filter((c: string | null) => !!c);
    const userNote = notes.length
      ? `The user's notes on these photos: ${notes.map((n) => `"${n}"`).join(", ")}`
      : "No additional notes were provided.";

    const content = [
      ...downloads.map((d) => ({ type: "image", source: { type: "base64", media_type: d!.mediaType, data: d!.base64 } })),
      {
        type: "text",
        text:
          `These ${orderedMedia.length} photos are all views of the SAME single item, for Houstory, an app for tracking a home's ` +
          "renovations, landscaping, paint colors, appliances, and history. " +
          userNote +
          " Categorize this item, combining information from all the photos. photo_titles must have exactly " +
          `${orderedMedia.length} entries, one per photo, in the same order the photos were given.`,
      },
    ];

    let group: any;
    try {
      group = await callClaude(CATEGORIZE_GROUP_TOOL, content);
    } catch (e) {
      return err(String((e as Error).message), 502);
    }

    const titles: string[] = Array.isArray(group.photo_titles) ? group.photo_titles : [];

    for (let i = 0; i < media_ids.length; i++) {
      const title = titles[i] ?? null;
      const { error: updateErr } = await sb
        .from("media")
        .update({
          title,
          ai_description: group.description,
          ai_extracted: {
            suggested: {
              chapter_type: group.chapter_type,
              description: group.description,
              suggested_chapter_name: group.suggested_chapter_name,
              fields: group.fields,
              title,
              group_media_ids: media_ids,
            },
          },
        })
        .eq("id", media_ids[i]);

      if (updateErr) return err(`Failed to save analysis for ${media_ids[i]}: ${updateErr.message}`, 500);
    }

    return json({ status: "ok", group, titles });
  }

  // ---- SINGLE photo path ----
  if (!media_id) return err("media_id or media_ids is required");

  const { data: media, error: mediaErr } = await sb
    .from("media")
    .select("id, storage_path, caption, kind")
    .eq("id", media_id)
    .single();

  if (mediaErr || !media) return err("media not found or not accessible", 404);
  if (media.kind !== "photo") return err("only photo analysis is supported right now", 400);
  if (!media.storage_path) return err("media has no storage_path", 400);

  const downloaded = await downloadAsBase64(sb, media.storage_path);
  if (!downloaded) return err("failed to download media", 500);

  const userNote = media.caption
    ? `The user attached this note when uploading: "${media.caption}"`
    : "No additional note was provided.";

  const content = [
    { type: "image", source: { type: "base64", media_type: downloaded.mediaType, data: downloaded.base64 } },
    {
      type: "text",
      text:
        "This photo is for Houstory, an app for tracking a home's renovations, landscaping, paint colors, appliances, and history. " +
        userNote +
        " Categorize this photo. Remember these are three different things: " +
        "'title' is a short label for THIS photo (for scanning a grid of many photos). " +
        "'description' is a longer description, also about this one photo only. " +
        "'suggested_chapter_name' is a broader project/theme name a human would want to keep filing similar photos under over time, not about this single photo at all.",
    },
  ];

  let suggestion: any;
  try {
    suggestion = await callClaude(CATEGORIZE_TOOL, content);
  } catch (e) {
    return err(String((e as Error).message), 502);
  }

  const { error: updateErr } = await sb
    .from("media")
    .update({
      title: suggestion.title,
      ai_description: suggestion.description,
      ai_extracted: { suggested: suggestion },
    })
    .eq("id", media_id);

  if (updateErr) return err(`Failed to save analysis: ${updateErr.message}`, 500);

  return json({ status: "ok", suggestion });
});
