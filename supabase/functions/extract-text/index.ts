// Extract structured text from a handwritten exam paper (image or PDF) using Lovable AI.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SYSTEM = `You are an expert OCR engine specialized in handwritten student exam papers, supporting both Bangla (বাংলা) and English handwriting.

Your job is to faithfully transcribe the handwriting into clean, well-structured Markdown that preserves the visual and logical layout of the original page.

Rules:
- Preserve question numbers (e.g. "1.", "Q2)", "৩।") and answer structure exactly as written.
- Render each question as a Markdown heading: "### Question 1" (translate "প্রশ্ন" labels naturally if used).
- Place the student's answer underneath as normal paragraphs, preserving paragraph breaks, bullet lists, and indentation.
- Keep Bangla text in Bangla script. Do NOT translate.
- For struck-through or illegible words use [illegible].
- Do not add commentary, do not summarize, do not grade. Output ONLY the transcription.
- If a page contains diagrams or figures, note them inline as: *[diagram: short description]*.

Always finish by returning the result through the provided tool. Estimate confidence as a number 0–1 reflecting how certain you are about the transcription quality.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY missing");

    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { evaluationId, filePath, mimeType } = await req.json();
    if (!evaluationId || !filePath) throw new Error("Missing evaluationId or filePath");

    // Service-role client to download the file (bucket is private, RLS already enforced via insert)
    const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    // Verify ownership: filePath should start with `${user.id}/`
    if (!filePath.startsWith(`${userData.user.id}/`)) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: file, error: dlErr } = await admin.storage.from("exam-papers").download(filePath);
    if (dlErr || !file) throw new Error(`Download failed: ${dlErr?.message}`);

    const buf = new Uint8Array(await file.arrayBuffer());
    // base64 encode
    let binary = "";
    for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
    const b64 = btoa(binary);
    const mime = mimeType || file.type || "application/octet-stream";
    const dataUrl = `data:${mime};base64,${b64}`;

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: "Transcribe this handwritten exam paper." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "return_transcription",
              description: "Return the structured transcription of the exam paper.",
              parameters: {
                type: "object",
                properties: {
                  markdown: { type: "string", description: "Structured Markdown transcription" },
                  language: { type: "string", enum: ["bangla", "english", "mixed"] },
                  confidence: { type: "number", description: "0..1 confidence score" },
                },
                required: ["markdown", "language", "confidence"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "return_transcription" } },
      }),
    });

    if (!aiRes.ok) {
      const txt = await aiRes.text();
      console.error("AI error", aiRes.status, txt);
      if (aiRes.status === 429)
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again shortly." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      if (aiRes.status === 402)
        return new Response(JSON.stringify({ error: "AI credits exhausted. Add credits in Settings → Workspace → Usage." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      throw new Error(`AI gateway error: ${aiRes.status}`);
    }

    const json = await aiRes.json();
    const call = json?.choices?.[0]?.message?.tool_calls?.[0];
    const args = call ? JSON.parse(call.function.arguments) : null;
    if (!args) throw new Error("Model returned no transcription");

    // Save to DB
    const { error: upErr } = await supabase
      .from("evaluations")
      .update({
        extracted_text: args.markdown,
        ocr_confidence: args.confidence,
        status: "extracted",
      })
      .eq("id", evaluationId);
    if (upErr) throw upErr;

    return new Response(
      JSON.stringify({ markdown: args.markdown, confidence: args.confidence, language: args.language }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("extract-text error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
