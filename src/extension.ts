// Live progress bars for long background jobs, read from their log files.
// Tool `job_progress` (start|stop|list|show) and command `/progress [stop <id>]`.
// A job is: log file + regex whose group 1 is the done-count (other groups are
// shown verbatim, e.g. spend) + total. Optional pid marks the job finished when
// the process exits. Jobs persist in ~/.pi/agent/job-progress.json.
import { readFileSync, writeFileSync, existsSync, statSync, openSync, readSync, closeSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface Job {
  id: string;
  label: string;
  logFile: string;
  labels?: string[]; // suffix per extra group, e.g. [" chips linked", ""]
  pattern: string; // group 1 = done count; further groups appended to the line
  total: number;
  pid?: number;
  startedAt: number;
}
interface Sample { t: number; done: number }

const STORE = join(homedir(), ".pi", "agent", "job-progress.json");
const PRESETS: Record<string, { pattern: string; labels: string[]; note: string }> = {
  // [chip-backfill] 700 cards · 825 chips linked · ... · $0.0394 · ...
  "chip-backfill": { pattern: String.raw`\[chip-backfill\] (\d+) cards · (\d+) chips linked.*?(\$[0-9.]+)`, labels: [" chips linked", " spend"], note: "cards / chips linked / spend" },
};

const jobs = new Map<string, Job>();
const samples = new Map<string, Sample[]>();
let timer: ReturnType<typeof setInterval> | undefined;
let lastCtx: ExtensionContext | undefined;
const hidden = new Set<string>(); // per session (process): ids not drawn here

const save = () => {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify([...jobs.values()], null, 1));
};
const load = () => {
  if (!existsSync(STORE)) return;
  try { for (const j of JSON.parse(readFileSync(STORE, "utf8")) as Job[]) jobs.set(j.id, j); } catch { /* ignore corrupt store */ }
};

function tail(file: string, bytes = 65536): string {
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally { closeSync(fd); }
}
const alive = (pid?: number) => { if (!pid) return undefined; try { process.kill(pid, 0); return true; } catch { return false; } };
const STALE_MS = 5 * 60_000; // no pid: log untouched this long means the job ended
const REMOVE_AFTER_MS = 10 * 60_000; // finished jobs disappear once the log has been quiet this long
function isFinished(job: Job): boolean {
  if (job.pid) return alive(job.pid) === false;
  return existsSync(job.logFile) && Date.now() - statSync(job.logFile).mtimeMs > STALE_MS;
}
const quietFor = (job: Job) => (existsSync(job.logFile) ? Date.now() - statSync(job.logFile).mtimeMs : 0);
const fmtDur = (s: number) => !isFinite(s) ? "?" : s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;

function render(job: Job, width = 30): string {
  if (!existsSync(job.logFile)) return `${job.label}: waiting for ${job.logFile}`;
  const re = new RegExp(job.pattern);
  const lines = tail(job.logFile).split("\n");
  let m: RegExpMatchArray | null = null;
  for (let i = lines.length - 1; i >= 0 && !m; i--) m = lines[i].match(re);
  const finished = isFinished(job);
  if (!m) return `${job.label}: ${finished ? "ended, no progress line" : "starting…"}`;
  const done = Number(m[1]);
  const s = samples.get(job.id) ?? [];
  const now = Date.now();
  if (!s.length || s[s.length - 1].done !== done) s.push({ t: now, done });
  while (s.length > 30) s.shift();
  samples.set(job.id, s);
  const first = s[0], last = s[s.length - 1];
  const rate = last.t > first.t ? ((last.done - first.done) / (last.t - first.t)) * 1000 : 0;
  const pct = Math.min(100, Math.floor((done * 100) / job.total));
  const f = Math.floor((pct * width) / 100);
  const bar = "█".repeat(f) + "░".repeat(width - f);
  const extra = m.slice(2).map((g, i) => (g ? g + (job.labels?.[i] ?? "") : "")).filter(Boolean).join(" · ");
  const eta = rate > 0 ? fmtDur((job.total - done) / rate) : "?";
  const state = finished ? (pct >= 99 ? " ✓ finished" : " ■ stopped") : "";
  return `${job.label} [${bar}] ${pct}% ${done.toLocaleString()}/${job.total.toLocaleString()}${extra ? " · " + extra : ""} · ${rate.toFixed(1)}/s · eta ${eta}${state}`;
}

function redraw() {
  const ctx = lastCtx;
  if (!ctx?.hasUI) return;
  for (const job of [...jobs.values()]) {
    if (isFinished(job) && quietFor(job) > REMOVE_AFTER_MS) { drop(job.id); hidden.delete(job.id); continue; }
    if (hidden.has(job.id)) { ctx.ui.setWidget(`job-progress:${job.id}`, undefined); continue; }
    try { ctx.ui.setWidget(`job-progress:${job.id}`, [render(job)], { placement: "belowEditor" }); }
    catch (e) { ctx.ui.setWidget(`job-progress:${job.id}`, [`${job.label}: ${(e as Error).message}`], { placement: "belowEditor" }); }
  }
}
function ensureTimer() {
  if (jobs.size && !timer) timer = setInterval(redraw, 2000);
  if (!jobs.size && timer) { clearInterval(timer); timer = undefined; }
}
function drop(id: string) {
  jobs.delete(id); samples.delete(id); save();
  lastCtx?.hasUI && lastCtx.ui.setWidget(`job-progress:${id}`, undefined);
  ensureTimer();
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_e, ctx) => {
    lastCtx = ctx; load(); redraw(); ensureTimer();
  });
  pi.on("session_shutdown", async () => { if (timer) clearInterval(timer); timer = undefined; });

  pi.registerTool({
    name: "job_progress",
    label: "Job progress",
    description:
      "Show a live progress bar (refreshes every 2s, no agent turn needed) for a long background job by reading its log file. " +
      "action=start needs id, logFile, total and either preset (chip-backfill) or pattern (regex; group 1 = done count, later groups shown as extras). " +
      "Pass pid so the bar shows finished/stopped. action=show returns a text bar now (use in print/RPC mode). action=stop removes it. action=list lists jobs.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("list"), Type.Literal("show")]),
      id: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      logFile: Type.Optional(Type.String()),
      preset: Type.Optional(Type.String({ description: `One of: ${Object.keys(PRESETS).join(", ")}` })),
      pattern: Type.Optional(Type.String({ description: "JS regex source, group 1 = done count" })),
      total: Type.Optional(Type.Number()),
      pid: Type.Optional(Type.Number()),
    }),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
      if (p.action === "list") return text([...jobs.values()].map(j => render(j)).join("\n") || "no jobs");
      if (p.action === "show") {
        const js = p.id ? [jobs.get(p.id)] : [...jobs.values()];
        return text(js.filter(Boolean).map(j => render(j!)).join("\n") || "no such job");
      }
      if (p.action === "stop") { if (!p.id) return text("id required"); drop(p.id); return text(`removed ${p.id}`); }
      const pattern = p.pattern ?? (p.preset ? PRESETS[p.preset]?.pattern : undefined);
      if (!p.id || !p.logFile || !p.total || !pattern) return text("start needs id, logFile, total and preset|pattern");
      try { new RegExp(pattern); } catch (e) { return text(`bad pattern: ${(e as Error).message}`); }
      jobs.set(p.id, { id: p.id, label: p.label ?? p.id, logFile: p.logFile, pattern, labels: p.preset ? PRESETS[p.preset]?.labels : undefined, total: p.total, pid: p.pid, startedAt: Date.now() });
      save(); redraw(); ensureTimer();
      return text(`tracking ${p.id}\n${render(jobs.get(p.id)!)}`);
    },
  });

  pi.registerCommand("progress", {
    description: "Job progress: `/progress` lists, `hide|unhide [id|all]` for this session only, `clear` removes finished jobs, `stop <id>` removes one for everyone",
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const [cmd, id] = (args ?? "").trim().split(/\s+/);
      const targets = () => (!id || id === "all" ? [...jobs.keys()] : jobs.has(id) ? [id] : []);
      if (cmd === "stop" && id) { drop(id); hidden.delete(id); ctx.ui.notify(`removed ${id}`, "info"); return; }
      if (cmd === "clear") {
        const done = [...jobs.values()].filter(isFinished).map(j => j.id);
        for (const d of done) { drop(d); hidden.delete(d); }
        ctx.ui.notify(done.length ? `cleared: ${done.join(", ")}` : "no finished jobs", "info");
        return;
      }
      if (cmd === "hide" || cmd === "unhide") {
        const ids = targets();
        for (const t of ids) cmd === "hide" ? hidden.add(t) : hidden.delete(t);
        redraw();
        ctx.ui.notify(ids.length ? `${cmd === "hide" ? "hidden" : "showing"}: ${ids.join(", ")}` : "no such job", "info");
        return;
      }
      redraw();
      ctx.ui.notify([...jobs.values()].map(j => `${hidden.has(j.id) ? "(hidden) " : ""}${render(j)}`).join("\n") || "no jobs", "info");
    },
  });
}
