// Extract structured text from one or more handwritten exam pages (image or PDF) using Lovable AI.
// Concatenates the transcripts when multiple files are supplied.
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
- Render each question as a Markdown heading: "### Question 1".
- Place the student's answer underneath as normal paragraphs, preserving paragraph breaks, bullet lists, and indentation.
- Keep Bangla text in Bangla script. Do NOT translate.
- For struck-through or illegible words use [illegible].
- Do not add commentary, do not summarize, do not grade. Output ONLY the transcription.
- If a page contains diagrams or figures, note them inline as: *[diagram: short description]*.

Always finish by returning the result through the provided tool. Estimate confidence as a number 0–1.`;

async function transcribeOne(dataUrl: string, apiKey: string, maxAttempts = 4) {
  let lastErr: { status: number; message: string } | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: "Transcribe this handwritten exam page." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        tools: [{
          type: "function",
          function: {
            name: "return_transcription",
            parameters: {
              type: "object",
              properties: {
                markdown: { type: "string" },
                language: { type: "string", enum: ["bangla", "english", "mixed"] },
                confidence: { type: "number" },
              },
              required: ["markdown", "language", "confidence"],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "return_transcription" } },
      }),
    });
    if (aiRes.ok) {
      const json = await aiRes.json();
      const call = json?.choices?.[0]?.message?.tool_calls?.[0];
      if (!call) throw new Error("Model returned no transcription");
      return JSON.parse(call.function.arguments) as { markdown: string; language: string; confidence: number };
    }
    // Non-OK: decide retry vs bail
    if (aiRes.status === 402) {
      lastErr = { status: 402, message: "AI credits exhausted." };
      break;
    }
    const retriable = aiRes.status === 429 || aiRes.status >= 500;
    lastErr = {
      status: aiRes.status,
      message: aiRes.status === 429 ? "Rate limit exceeded." : `AI gateway error: ${aiRes.status}`,
    };
    if (!retriable || attempt === maxAttempts) break;
    // Exponential backoff with jitter: ~2s, 4s, 8s
    const delay = Math.min(8000, 1000 * 2 ** attempt) + Math.random() * 500;
    await new Promise((r) => setTimeout(r, delay));
  }
  const err = new Error(lastErr?.message ?? "AI gateway error") as Error & { status?: number };
  err.status = lastErr?.status;
  throw err;
}

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
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { evaluationId } = body;
    // Accept either { filePath, mimeType } (legacy single) or { files: [{path, mime}] } (multi)
    const files: { path: string; mime?: string; name?: string }[] = body.files
      ?? (body.filePath ? [{ path: body.filePath, mime: body.mimeType }] : []);
    if (!evaluationId || files.length === 0) throw new Error("Missing evaluationId or files");

    const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    for (const f of files) {
      if (!f.path.startsWith(`${userData.user.id}/`)) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const transcripts: { name: string; markdown: string; confidence: number }[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const { data: file, error: dlErr } = await admin.storage.from("exam-papers").download(f.path);
      if (dlErr || !file) throw new Error(`Download failed for ${f.path}: ${dlErr?.message}`);
      const buf = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let j = 0; j < buf.length; j++) binary += String.fromCharCode(buf[j]);
      const b64 = btoa(binary);
      const mime = f.mime || file.type || "application/octet-stream";
      const dataUrl = `data:${mime};base64,${b64}`;
      const t = await transcribeOne(dataUrl, LOVABLE_API_KEY);
      transcripts.push({ name: f.name ?? `Page ${i + 1}`, markdown: t.markdown, confidence: t.confidence });
    }

    const combined = transcripts.length === 1
      ? transcripts[0].markdown
      : transcripts.map((t, i) => `<!-- ${t.name} -->\n## Page ${i + 1}\n\n${t.markdown}`).join("\n\n---\n\n");
    const avgConf = transcripts.reduce((s, t) => s + t.confidence, 0) / transcripts.length;

    const { error: upErr } = await supabase
      .from("evaluations")
      .update({
        extracted_text: combined,
        ocr_confidence: avgConf,
        status: "extracted",
      })
      .eq("id", evaluationId);
    if (upErr) throw upErr;

    return new Response(
      JSON.stringify({ markdown: combined, confidence: avgConf, pages: transcripts.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("extract-text error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
