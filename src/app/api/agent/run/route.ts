import { getSession } from "@/lib/auth";
import { runAgent } from "@/lib/agent";
import { AgentEvent, Mode } from "@/lib/types";
import { hasLLMKey } from "@/lib/llm";
import { hasExaKey } from "@/lib/exa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Hobby plan caps functions at 60s; the two-stage flow runs ~15-40s.
export const maxDuration = 60;

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  if (!hasLLMKey()) return Response.json({ error: "OPENROUTER_API_KEY missing." }, { status: 400 });
  if (!hasExaKey()) return Response.json({ error: "EXA_API_KEY missing." }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const prompt = String(body.prompt ?? "").trim();
  const mode: Mode = body.mode === "sales" ? "sales" : "sponsor";
  const answers = body.answers ? String(body.answers) : undefined;
  const skipClarify = Boolean(body.skipClarify);
  if (!prompt) return Response.json({ error: "Prompt is required." }, { status: 400 });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
        } catch {
          // controller closed
        }
      };
      try {
        await runAgent({ prompt, mode, answers, skipClarify, userName: session.name }, emit);
      } catch (e) {
        emit({ type: "error", message: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
