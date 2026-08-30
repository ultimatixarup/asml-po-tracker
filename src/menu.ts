/**
 * Deterministic menu layer, shared by both channels. Works with nothing but
 * plain text (the lowest common denominator of WhatsApp and Telegram):
 * "menu" / "help" / "?" opens it, digits navigate while it's open, anything
 * else drops the user back to free-form conversation with the agent.
 *
 * Menu replies are instant and free -- no model call. Leaves either print
 * detailed instructions for what to send next, or forward a canned request
 * into the agent.
 */

export interface MenuAction {
  /** Text to send back directly (no model call). */
  reply?: string;
  /** Text to run through the agent as if the user had typed it. */
  forward?: string;
}

interface MenuNode {
  render: string;
  /** digit -> child node id, instruction leaf, or forward leaf */
  options: Record<string, { node?: string; reply?: string; forward?: string }>;
}

const B = (s: string) => `*${s}*`;

const NODES: Record<string, MenuNode> = {
  root: {
    render: [
      `${B("Main menu")} — reply with a number:`,
      "1. Projects",
      "2. Field updates — photos, receipts, notes, daily logs",
      "3. Estimates",
      "4. Change orders",
      "5. Status & ledger",
      "",
      "Reply 0 here anytime to reopen this menu.",
      "Or ignore the menu and just talk to me — plain language works.",
    ].join("\n"),
    options: {
      "1": { node: "projects" },
      "2": { node: "field" },
      "3": { node: "estimates" },
      "4": { node: "cos" },
      "5": {
        forward:
          "Give me a status summary: active project, current estimate version and total, change orders with status, and the last 5 ledger events.",
      },
    },
  },

  projects: {
    render: [
      `${B("Projects")} — reply with a number:`,
      "1. List my projects",
      "2. Create a project (I'll show the format)",
      "3. Switch my active project",
      "0. Back",
    ].join("\n"),
    options: {
      "1": { forward: "List my projects." },
      "2": {
        reply: [
          `${B("Create a project")} — send one message with:`,
          "code, name, address",
          "",
          "Example:",
          "```MAPLE, Maple St Renovation, 123 Maple St, Dallas TX```",
          "",
          "- code: short and memorable (2-16 chars); leave it out and I'll invent one",
          "- name: what the crew calls the job",
          "- address: optional but useful on documents",
          "",
          "Plain language works too: \"set up a project for the office remodel on Oak Ave\".",
        ].join("\n"),
      },
      "3": {
        reply: [
          `${B("Switch project")} — send:`,
          "```switch to CODE```",
          "",
          'Example: "switch to MAPLE". Not sure of the code? Say "list projects" first.',
          "Everything you send afterwards files under the active project.",
        ].join("\n"),
      },
    },
  },

  field: {
    render: [
      `${B("Field updates")} — reply with a number:`,
      "1. How to send photos & receipts",
      "2. Record a note",
      "3. Record a daily log",
      "0. Back",
    ].join("\n"),
    options: {
      "1": {
        reply: [
          `${B("Photos & receipts")} — just send the image or PDF, with a short caption:`,
          "",
          "- caption tells me what I'm looking at. Example captions:",
          '  "slab crack, garage bay 3"  ·  "receipt, extra rebar"',
          "- I file it under your active project, summarize it, and put it on the ledger as evidence",
          "- if it signals a scope or cost change, I flag it for change-order work",
          "- limit 20MB per file; spreadsheets are treated as estimates (see Estimates menu)",
        ].join("\n"),
      },
      "2": {
        reply: [
          `${B("Record a note")} — send:`,
          "```note: what happened```",
          "",
          'Example: "note: owner verbally approved the tile upgrade, will confirm by email".',
          "Notes are ledger evidence — decisions, directives, and site conditions belong here.",
        ].join("\n"),
      },
      "3": {
        reply: [
          `${B("Daily log")} — send one message covering:`,
          "crew size, weather, work performed, delays (if any)",
          "",
          "Example:",
          "```daily log: crew 5, clear 85F, framed north wall and set door bucks, no delays```",
          "",
          "Daily logs are the strongest dispute evidence there is — one per day pays for itself.",
        ].join("\n"),
      },
    },
  },

  estimates: {
    render: [
      `${B("Estimates")} — reply with a number:`,
      "1. How to import an estimate",
      "2. Show the current estimate",
      "0. Back",
    ].join("\n"),
    options: {
      "1": {
        reply: [
          `${B("Import an estimate")} — two steps:`,
          "",
          '1. Send the spreadsheet (.xlsx or .csv) as a document, caption "estimate"',
          "   - any column layout works; I figure out which column is which",
          "   - one line per cost item; qty / unit / unit cost / total columns help",
          '2. Say "import it" — I reply with the line count, grand total, and anything',
          "   flagged. NOTHING commits until you answer yes.",
          "",
          "Example: attach maple-bid.xlsx, then send \"import it\", then \"yes\".",
          "Re-importing later creates version 2; version 1 stays on the record.",
        ].join("\n"),
      },
      "2": { forward: "Show me the current estimate: version, total, and the largest lines." },
    },
  },

  cos: {
    render: [
      `${B("Change orders")} — reply with a number:`,
      "1. How to draft a change order",
      "2. List change orders",
      "3. How approval works",
      "0. Back",
    ].join("\n"),
    options: {
      "1": {
        reply: [
          `${B("Draft a change order")} — tell me, in plain language:`,
          "- what changed and where",
          "- quantities if you know them (I'll price from the estimate's own unit costs)",
          "",
          'Example: "owner wants the kitchen wall moved 2 ft north — draft the change order"',
          "",
          "I reconcile against the current estimate and price ONLY the delta — extras and",
          "credits — with the math shown and every line citing its evidence. Drafting takes",
          "about a minute; the summary lands here when it's ready.",
          "",
          "Tip: send the photos/notes/plans behind the change FIRST — they become the evidence.",
        ].join("\n"),
      },
      "2": { forward: "List the change orders with number, status, title, and net amount." },
      "3": {
        reply: [
          `${B("Approval workflow")} — three steps, and I can't skip any:`,
          "",
          "PCO (draft) → COR (sent to owner) → approved",
          "",
          '- "advance CO 1 to COR" — when the team decides to pursue it',
          '- "CO 1 is approved" — ONLY after the owner has actually signed off',
          "- I never advance status on my own, and I can't approve anything myself",
          "Every transition is recorded on the ledger with who ordered it.",
        ].join("\n"),
      },
    },
  },
};

const OPEN_TRIGGERS = new Set(["menu", "/menu", "help", "/help", "?", "0"]);

/** Per-contact menu position. Ephemeral UX state; in-memory is fine. */
const positions = new Map<string, string>();

/**
 * Intercept a message before it reaches the agent. Returns null when the
 * message is normal conversation (and closes any open menu).
 */
export function handleMenu(contactId: string, text: string): MenuAction | null {
  const input = text.trim().toLowerCase();

  if (OPEN_TRIGGERS.has(input)) {
    positions.set(contactId, "root");
    return { reply: NODES.root!.render };
  }

  const position = positions.get(contactId);
  if (!position) return null;

  // Only bare digits navigate; anything else is conversation again.
  if (!/^\d$/.test(input)) {
    positions.delete(contactId);
    return null;
  }

  const node = NODES[position]!;
  const choice = node.options[input];
  if (!choice) {
    return {
      reply: `That's not an option here. ${node.render}`,
    };
  }
  if (choice.node) {
    positions.set(contactId, choice.node);
    return { reply: NODES[choice.node]!.render };
  }
  positions.delete(contactId);
  if (choice.forward) return { forward: choice.forward };
  return { reply: choice.reply! };
}

/** The menu the /start command and first-time contacts see. */
export function rootMenu(): string {
  return NODES.root!.render;
}
