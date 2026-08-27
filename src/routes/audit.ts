import { Router } from "express";
import { verifyChain } from "../ledger.ts";
import type { BlobStore } from "../storage.ts";
import type { Store } from "../store.ts";

/**
 * Read-only audit pages: the dispute-resolution surface. Server-rendered
 * HTML, no build step, no session state. Gated by a bearer token
 * (Authorization header, or ?token= once, which sets a cookie).
 */

const esc = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const money = (value: number): string =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 70rem; padding: 0 1rem; color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { background: #f5f5f5; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .ok { color: #0a7d38; font-weight: 600; }
  .bad { color: #b40000; font-weight: 600; }
  .muted { color: #777; font-size: .85em; }
  code { background: #f2f2f2; padding: .1em .3em; border-radius: 3px; font-size: .85em; }
  a { color: #0b57d0; }
  h1 a { color: inherit; text-decoration: none; }
</style></head><body><h1><a href="/audit">Audit</a></h1>${body}</body></html>`;
}

export function createAuditRouter(
  store: Store,
  blobs: BlobStore | null,
  token: string,
): Router {
  const router = Router();

  router.use("/audit", (req, res, next) => {
    const fromQuery = req.query.token;
    if (typeof fromQuery === "string" && fromQuery === token) {
      res.cookie?.("audit_token", token, { httpOnly: true, sameSite: "strict" });
      res.redirect(req.path === "/" ? "/audit" : `/audit${req.path}`);
      return;
    }
    const header = req.get("authorization");
    const cookie = req.headers.cookie
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("audit_token="))
      ?.slice("audit_token=".length);
    if (header === `Bearer ${token}` || cookie === token) {
      next();
      return;
    }
    res.status(401).send(page("Unauthorized", "<p>Append <code>?token=...</code> once, or send the bearer token.</p>"));
  });

  router.get("/audit", async (_req, res) => {
    const projects = await store.listProjects();
    const rows = await Promise.all(
      projects.map(async (p) => {
        const chain = await store.getChain(p.id);
        const verdict = verifyChain(chain);
        return `<tr><td><a href="/audit/p/${esc(p.id)}">${esc(p.code)}</a></td>
          <td>${esc(p.name)}</td><td>${esc(p.status)}</td>
          <td class="num">${chain.length}</td>
          <td>${verdict.ok ? '<span class="ok">chain intact</span>' : '<span class="bad">CHAIN BROKEN</span>'}</td></tr>`;
      }),
    );
    res.send(
      page(
        "Projects",
        `<table><tr><th>Code</th><th>Name</th><th>Status</th><th class="num">Events</th><th>Ledger</th></tr>${rows.join("")}</table>`,
      ),
    );
  });

  router.get("/audit/p/:id", async (req, res) => {
    const project = await store.getProject(req.params.id);
    if (!project) {
      res.status(404).send(page("Not found", "<p>No such project.</p>"));
      return;
    }
    const [events, chain, estimates, changeOrders] = await Promise.all([
      store.listEvents(project.id, { limit: 200 }),
      store.getChain(project.id),
      store.listEstimates(project.id),
      store.listChangeOrders(project.id),
    ]);
    const verdict = verifyChain(chain);

    const estimateRows = estimates
      .map(
        (e) =>
          `<tr><td>v${e.version}</td><td>${esc(e.status)}</td><td class="num">${money(e.total)}</td></tr>`,
      )
      .join("");
    const coRows = changeOrders
      .map(
        (c) =>
          `<tr><td><a href="/audit/p/${esc(project.id)}/co/${c.number}">PCO #${c.number}</a></td>
           <td>${esc(c.title)}</td><td>${esc(c.status)}</td><td class="num">${money(c.netAmount)}</td></tr>`,
      )
      .join("");
    const eventRows = [...events]
      .reverse()
      .map(
        (e) => `<tr><td class="muted">${esc(e.id)}</td><td>${esc(e.type)}</td>
          <td>${esc(e.actor)}</td>
          <td><code>${esc(JSON.stringify(e.payload).slice(0, 160))}</code>
          ${e.artifactId ? `<a href="/audit/artifact/${esc(e.artifactId)}">artifact</a>` : ""}</td>
          <td class="muted">${esc(e.createdAt.slice(0, 19))}</td></tr>`,
      )
      .join("");

    res.send(
      page(
        project.code,
        `<h2>${esc(project.code)} — ${esc(project.name)}</h2>
        <p>Ledger: ${verdict.ok ? '<span class="ok">chain intact</span>' : `<span class="bad">CHAIN BROKEN at index ${verdict.brokenAtIndex}</span>`}
        (${chain.length} events, <a href="/audit/verify/${esc(project.id)}">verify JSON</a>)</p>
        <h3>Estimates</h3><table><tr><th>Version</th><th>Status</th><th class="num">Total</th></tr>${estimateRows || "<tr><td colspan=3>none</td></tr>"}</table>
        <h3>Change orders</h3><table><tr><th>#</th><th>Title</th><th>Status</th><th class="num">Net</th></tr>${coRows || "<tr><td colspan=4>none</td></tr>"}</table>
        <h3>Event timeline (newest first)</h3>
        <table><tr><th>Id</th><th>Type</th><th>Actor</th><th>Payload</th><th>At</th></tr>${eventRows}</table>`,
      ),
    );
  });

  router.get("/audit/p/:id/co/:number", async (req, res) => {
    const project = await store.getProject(req.params.id);
    const found = project
      ? await store.getChangeOrder(project.id, Number(req.params.number))
      : null;
    if (!project || !found) {
      res.status(404).send(page("Not found", "<p>No such change order.</p>"));
      return;
    }
    const lineRows = found.lines
      .map(
        (l) => `<tr><td>${esc(l.kind)}</td><td>${esc(l.csiCode ?? "—")}</td>
        <td>${esc(l.description)}</td>
        <td class="num">${l.qty ?? "—"} ${esc(l.unit ?? "")}</td>
        <td class="num">${l.unitCost === null ? "—" : money(l.unitCost)}</td>
        <td class="num">${money(l.total)}</td>
        <td><code>${esc(l.mathNote ?? "")}</code><br><span class="muted">${esc(l.rationale ?? "")}</span></td>
        <td>${l.evidenceEventIds.map((id) => `<code>${esc(id)}</code>`).join(" ")}</td></tr>`,
      )
      .join("");
    res.send(
      page(
        `PCO #${found.co.number}`,
        `<h2><a href="/audit/p/${esc(project.id)}">${esc(project.code)}</a> — PCO #${found.co.number}: ${esc(found.co.title)}</h2>
        <p>Status: <b>${esc(found.co.status)}</b> · Net: <b>${money(found.co.netAmount)}</b> · Base estimate: <code>${esc(found.co.baseEstimateId)}</code></p>
        <table><tr><th>Kind</th><th>CSI</th><th>Description</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Total</th><th>Math / basis</th><th>Evidence</th></tr>${lineRows}</table>
        <p class="muted">Every line's evidence ids reference ledger events on the project timeline; the ai.call_recorded event holds the hashed model exchange.</p>`,
      ),
    );
  });

  router.get("/audit/artifact/:id", async (req, res) => {
    const artifact = await store.getArtifact(req.params.id);
    if (!artifact) {
      res.status(404).send(page("Not found", "<p>No such artifact.</p>"));
      return;
    }
    if (!blobs) {
      res.send(
        page(
          "Artifact",
          `<h2>${esc(artifact.id)}</h2><p>${esc(artifact.kind)}, ${esc(artifact.mime)}, sha256 <code>${esc(artifact.sha256)}</code></p><p>Blob storage is not configured; bytes unavailable.</p>`,
        ),
      );
      return;
    }
    res.redirect(await blobs.presignGet(artifact.blobKey, 300));
  });

  router.get("/audit/verify/:projectId", async (req, res) => {
    const chain = await store.getChain(req.params.projectId);
    res.json({ events: chain.length, ...verifyChain(chain) });
  });

  return router;
}
