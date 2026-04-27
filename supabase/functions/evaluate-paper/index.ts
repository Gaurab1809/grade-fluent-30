// Evaluate a transcript against a rubric using ONE specified model. Stores result in model_runs.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SYSTEM_BASE = `You are a fair, experienced examiner grading a student's handwritten answers (Bangla, English, or mixed). Grade against the rubric.

Rules:
- Identify EACH SCORING CRITERION in the rubric (e.g. "definition: 5 marks", "example: 3 marks") and score it individually with concise feedback.
- Also produce question-level scores: question_number, question_summary, score_awarded, score_max, feedback.
- If rubric specifies marks per question/criterion, follow exactly. If not, distribute evenly to total 100.
- If an answer is empty/illegible, score 0 and say so.
- Be fair, encouraging, concrete. Match feedback language to the student's answer language.
- Always return through the provided tool.`;

const FEW_SHOT_HEADER = `\nHere are example gradings from this teacher for calibration. Match the teacher's strictness and style.\n`;

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

    const {
      evaluationId,
      extractedText,
      rubric,
      model = "google/gemini-2.5-flash",
      promptVariant = "baseline",
      fewShotExamples = [], // [{rubric, transcript, criterion_scores}]
    } = await req.json();
    if (!evaluationId || !extractedText || !rubric) throw new Error("Missing evaluationId, extractedText, or rubric");

    let systemPrompt = SYSTEM_BASE;
    if (promptVariant === "few-shot" && fewShotExamples.length > 0) {
      systemPrompt += FEW_SHOT_HEADER + fewShotExamples.slice(0, 3).map((ex: any, i: number) =>
        `--- EXAMPLE ${i + 1} ---\nRUBRIC:\n${ex.rubric}\n\nSTUDENT TRANSCRIPT:\n${ex.transcript}\n\nTEACHER'S CRITERION SCORES:\n${JSON.stringify(ex.criterion_scores, null, 2)}`
      ).join("\n\n");
    }
    if (promptVariant === "strict") {
      systemPrompt += "\n\nGrade strictly. Penalize incomplete reasoning, missing key terms, and factual errors. Never round up.";
    }
    if (promptVariant === "lenient") {
      systemPrompt += "\n\nGrade generously. Reward partial understanding and effort, even if minor details are missing.";
    }

    const userPrompt = `RUBRIC:\n${rubric}\n\n---\nSTUDENT ANSWER TRANSCRIPT:\n${extractedText}`;

    const t0 = Date.now();
    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        tools: [{
          type: "function",
          function: {
            name: "return_evaluation",
            description: "Return the per-question and per-criterion grading.",
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
                criterion_scores: {
                  type: "array",
                  description: "Each scoring criterion or sub-mark from the rubric, scored individually.",
                  items: {
                    type: "object",
                    properties: {
                      question_number: { type: "string" },
                      criterion: { type: "string" },
                      awarded: { type: "number" },
                      max: { type: "number" },
                      feedback: { type: "string" },
                    },
                    required: ["question_number", "criterion", "awarded", "max", "feedback"],
                    additionalProperties: false,
                  },
                },
                total_score: { type: "number" },
                max_score: { type: "number" },
                overall_feedback: { type: "string" },
              },
              required: ["questions", "criterion_scores", "total_score", "max_score", "overall_feedback"],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "return_evaluation" } },
      }),
    });
    const latency = Date.now() - t0;

    if (!aiRes.ok) {
      const txt = await aiRes.text();
      console.error("AI error", aiRes.status, txt);
      // Record the failure so the metrics page can show a missing run
      await supabase.from("model_runs").insert({
        evaluation_id: evaluationId, user_id: userData.user.id, model, prompt_variant: promptVariant,
        latency_ms: latency, error: `${aiRes.status}: ${txt.slice(0, 500)}`,
      });
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
    if (!args) throw new Error("Model returned no evaluation");

    // Insert a model_runs row
    const { data: run, error: runErr } = await supabase
      .from("model_runs")
      .insert({
        evaluation_id: evaluationId,
        user_id: userData.user.id,
        model,
        prompt_variant: promptVariant,
        evaluation_json: args,
        criterion_scores: args.criterion_scores,
        total_score: args.total_score,
        max_score: args.max_score,
        latency_ms: latency,
      })
      .select()
      .single();
    if (runErr) throw runErr;

    // Also persist the rubric/transcript on evaluations and set this run as primary if none yet.
    const { data: evRow } = await supabase
      .from("evaluations")
      .select("primary_run_id")
      .eq("id", evaluationId)
      .single();

    const updates: Record<string, unknown> = {
      rubric,
      extracted_text: extractedText,
      evaluation_json: args,
      total_score: args.total_score,
      max_score: args.max_score,
      status: "evaluated",
    };
    if (!evRow?.primary_run_id) updates.primary_run_id = run.id;

    const { error: upErr } = await supabase.from("evaluations").update(updates).eq("id", evaluationId);
    if (upErr) throw upErr;

    return new Response(JSON.stringify({ ...args, run_id: run.id, model, latency_ms: latency }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("evaluate-paper error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
