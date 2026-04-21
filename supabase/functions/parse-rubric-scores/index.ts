// Parse a teacher's rubric for per-question awarded marks + total via Lovable AI.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SYSTEM = `You extract a teacher's manually-awarded marks from a rubric document.
The rubric may be in Bangla, English, or mixed, and may be from Excel, Word, or plain text.
For each question, identify:
- question_number (string, e.g. "1", "2a")
- awarded (number — the marks the teacher actually gave the student)
- max (number — the maximum marks for that question)

Also extract the overall total_awarded and total_max if present.
If the rubric does NOT contain awarded marks (only the scoring scheme), return awarded as null for each question.
Always return through the provided tool. Do not invent numbers.`;

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

    const { evaluationId, rubric } = await req.json();
    if (!evaluationId || !rubric) throw new Error("Missing evaluationId or rubric");

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `RUBRIC:\n${rubric}` },
        ],
        tools: [{
          type: "function",
          function: {
            name: "return_human_scores",
            description: "Return the teacher's awarded marks parsed from the rubric.",
            parameters: {
              type: "object",
              properties: {
                questions: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      question_number: { type: "string" },
                      awarded: { type: ["number", "null"] },
                      max: { type: "number" },
                    },
                    required: ["question_number", "awarded", "max"],
                    additionalProperties: false,
                  },
                },
                total_awarded: { type: ["number", "null"] },
                total_max: { type: ["number", "null"] },
              },
              required: ["questions", "total_awarded", "total_max"],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "return_human_scores" } },
      }),
    });

    if (!aiRes.ok) {
      const txt = await aiRes.text();
      console.error("AI error", aiRes.status, txt);
      if (aiRes.status === 429)
        return new Response(JSON.stringify({ error: "Rate limit exceeded." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      if (aiRes.status === 402)
        return new Response(JSON.stringify({ error: "AI credits exhausted." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      throw new Error(`AI gateway error: ${aiRes.status}`);
    }

    const json = await aiRes.json();
    const call = json?.choices?.[0]?.message?.tool_calls?.[0];
    const args = call ? JSON.parse(call.function.arguments) : null;
    if (!args) throw new Error("Model returned no parse");

    // Compute total from questions if AI didn't surface one
    let total_awarded = args.total_awarded;
    let total_max = args.total_max;
    if (total_awarded == null) {
      const sum = args.questions.reduce((s: number, q: any) => s + (typeof q.awarded === "number" ? q.awarded : 0), 0);
      total_awarded = args.questions.every((q: any) => q.awarded == null) ? null : sum;
    }
    if (total_max == null) {
      total_max = args.questions.reduce((s: number, q: any) => s + (q.max ?? 0), 0) || null;
    }

    const { error: upErr } = await supabase
      .from("evaluations")
      .update({
        human_scores: args.questions,
        human_total: total_awarded,
        human_max: total_max,
      })
      .eq("id", evaluationId);
    if (upErr) throw upErr;

    return new Response(JSON.stringify({
      questions: args.questions, total_awarded, total_max,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("parse-rubric-scores error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
