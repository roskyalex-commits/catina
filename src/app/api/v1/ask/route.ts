import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ASK_SYSTEM_PROMPT, ASK_TOOLS, runAskTool } from "@/lib/ask/tools";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/ask — natural-language questions over the user's own data.
 *
 * Runs the tool loop server-side and returns the final answer plus a record of
 * which tools ran. The trace is returned deliberately: the product's position is
 * that a number you cannot interrogate is a number you will not trust, and that
 * applies to an LLM's answer more than anything else on the screen.
 */

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(8_000),
});

const bodySchema = z.object({
  messages: z.array(messageSchema).min(1).max(20),
});

/** Bounded so a confused model cannot loop through the month's token budget. */
const MAX_TURNS = 5;

export async function POST(request: Request) {
  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  let apiKey: string;
  try {
    apiKey = getEnv().ANTHROPIC_API_KEY;
  } catch {
    return NextResponse.json(
      {
        error:
          "Ask needs ANTHROPIC_API_KEY. Add it to .env.local and restart the dev server.",
      },
      { status: 503 },
    );
  }

  const client = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = parsed.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const toolsUsed: { name: string; input: unknown }[] = [];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const response = await client.messages.create({
        model: "claude-opus-5",
        max_tokens: 1_500,
        system: ASK_SYSTEM_PROMPT,
        tools: ASK_TOOLS,
        messages,
      });

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );

      if (toolUses.length === 0) {
        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();

        return NextResponse.json({
          answer: text || "I could not work that out from your data.",
          toolsUsed,
        });
      }

      messages.push({ role: "assistant", content: response.content });

      const results = await Promise.all(
        toolUses.map(async (use) => {
          toolsUsed.push({ name: use.name, input: use.input });
          const output = await runAskTool(
            use.name,
            (use.input ?? {}) as Record<string, unknown>,
          );
          return {
            type: "tool_result" as const,
            tool_use_id: use.id,
            content: JSON.stringify(output),
          };
        }),
      );

      messages.push({ role: "user", content: results });
    }

    return NextResponse.json({
      answer:
        "That took more steps than I allow in one question. Try asking something narrower.",
      toolsUsed,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Ask failed: ${detail}` },
      { status: 502 },
    );
  }
}
