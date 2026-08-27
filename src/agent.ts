import Anthropic from "@anthropic-ai/sdk";

/**
 * "Hello world" agent: a single Claude call per inbound WhatsApp message, with a
 * short rolling history per contact so the conversation feels continuous.
 */

const MODEL = "claude-opus-5";

/**
 * WhatsApp rejects text bodies over 4096 characters, so there is no point
 * generating more than a couple of paragraphs.
 */
const MAX_TOKENS = 1024;

/** User+assistant messages retained per contact (10 turns). */
const HISTORY_LIMIT = 20;

const SYSTEM_PROMPT = [
  "You are Hello World, a friendly agent that people reach over WhatsApp.",
  "Greet first-time contacts with a short hello and say what you can do.",
  "Keep replies under 100 words, plain text, no markdown headings or tables --",
  "WhatsApp renders only *bold*, _italic_ and ```code```.",
  "If you do not know something, say so plainly.",
].join(" ");

const GREETING =
  "Hello, world! \u{1F44B} I'm a demo agent running on WhatsApp. " +
  "Set ANTHROPIC_API_KEY on the server and I'll start thinking for real.";

/** In-memory history. Swap for Redis or a database before running more than one instance. */
const histories = new Map<string, Anthropic.MessageParam[]>();

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

/** Drop a contact's conversation, e.g. when they say "reset". */
export function forgetConversation(contactId: string): void {
  histories.delete(contactId);
}

/**
 * Produce the agent's reply to one inbound message.
 *
 * @param contactId - the sender's WhatsApp ID, used as the conversation key.
 * @param text - the inbound message body.
 */
export async function respond(contactId: string, text: string): Promise<string> {
  if (!client) {
    return GREETING;
  }

  const history = histories.get(contactId) ?? [];
  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: text },
  ];

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
      // Chat is latency-sensitive; thinking stays on (the default on Opus 5)
      // but at the cheapest, fastest depth.
      output_config: { effort: "low" },
      // Rescue a policy decline on a fallback model inside the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    if (response.stop_reason === "refusal") {
      return "Sorry, I can't help with that one. Ask me something else?";
    }

    const reply = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    if (!reply) {
      return "Sorry, I came up empty on that. Try rephrasing?";
    }

    const assistantTurn: Anthropic.MessageParam = {
      role: "assistant",
      content: reply,
    };
    histories.set(contactId, [...messages, assistantTurn].slice(-HISTORY_LIMIT));
    return reply;
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error("[agent] ANTHROPIC_API_KEY is invalid");
      return "My API credentials aren't working right now. Please tell my operator.";
    }
    if (error instanceof Anthropic.RateLimitError) {
      return "I'm being rate limited at the moment -- try me again in a minute.";
    }
    if (error instanceof Anthropic.APIError) {
      console.error(`[agent] API error ${error.status}: ${error.message}`);
    } else {
      console.error("[agent] unexpected error", error);
    }
    return "Something went wrong on my side. Try again shortly.";
  }
}
