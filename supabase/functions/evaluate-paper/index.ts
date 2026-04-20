// Evaluate the extracted exam text against a teacher-provided rubric.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SYSTEM = `You are a fair, experienced examiner grading a student's handwritten answers. The student's transcript may be in Bangla, English, or both. Grade each question against the rubric.

Rules:
- Read the rubric carefully. If the rubric specifies marks per question, follow them exactly. If it does not, distribute marks evenly across detected questions, totaling 100.
- For each question, give: question_number, a one-line question_summary, score_awarded, score_max, and concise feedback (1–3 sentences). Feedback should reference what the student got right and what was missing.
- Be fair, encouraging, and concrete. If an answer is empty/illegible, score 0 and say so.
- Provide an overall short summary (2–3 sentences) suitable for a report card.
- Match the language of the student's answer for feedback when possible (Bangla feedback for Bangla answers).
- Always return your result through the provided tool.`;

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

    const { evaluationId, extractedText, rubric } = await req.json();
    if (!evaluationId || !extractedText || !rubric) throw new Error("Missing evaluationId, extractedText, or rubric");

    const userPrompt = `RUBRIC:\n${rubric}\n\n---\nSTUDENT ANSWER TRANSCRIPT:\n${extractedText}`;

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
          { role: "user", content: userPrompt },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "return_evaluation",
              description: "Return the per-question grading and overall summary.",
              parameters: {
                type: "object",
                properties: {
                  questions: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        question_number: { type: "string" },
                        question_summary: { type: "string" },
                        score_awarded: { type: "number" },
                        score_max: { type: "number" },
                        feedback: { type: "string" },
                      },
                      required: ["question_number", "question_summary", "score_awarded", "score_max", "feedback"],
                      additionalProperties: false,
                    },
                  },
                  total_score: { type: "number" },
                  max_score: { type: "number" },
                  overall_feedback: { type: "string" },
                },
                required: ["questions", "total_score", "max_score", "overall_feedback"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "return_evaluation" } },
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
    if (!args) throw new Error("Model returned no evaluation");

    const { error: upErr } = await supabase
      .from("evaluations")
      .update({
        rubric,
        extracted_text: extractedText,
        evaluation_json: args,
        total_score: args.total_score,
        max_score: args.max_score,
        status: "evaluated",
      })
      .eq("id", evaluationId);
    if (upErr) throw upErr;

    return new Response(JSON.stringify(args), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("evaluate-paper error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
