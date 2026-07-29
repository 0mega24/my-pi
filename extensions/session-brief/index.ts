import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const COMMAND_TIMEOUT_MS = 2_000;

type Settings = {
  packages?: string[];
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
};

async function runGit(args: string[], cwd: string) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function readSettings() {
  try {
    return require("../../settings.json") as Settings;
  } catch {
    return {} satisfies Settings;
  }
}

function countChangedFiles(status: string | null) {
  if (!status) return 0;
  return status.split("\n").filter(Boolean).length;
}

function formatPackages(packages: string[] | undefined) {
  if (!packages?.length) return "none configured";
  return packages.map((pkg) => pkg.replace(/^npm:/, "")).join(", ");
}

function formatModel(ctx: ExtensionContext) {
  const model = ctx.model;
  const provider =
    model?.provider ?? process.env.PI_PROVIDER ?? "unknown-provider";
  const id = model?.id ?? process.env.PI_MODEL ?? "unknown-model";
  return `${provider}/${id}`;
}

async function buildBrief(ctx: ExtensionContext, pi: ExtensionAPI) {
  const settings = readSettings();
  const [insideRepo, branch, head, status] = await Promise.all([
    runGit(["rev-parse", "--is-inside-work-tree"], ctx.cwd),
    runGit(["branch", "--show-current"], ctx.cwd),
    runGit(["rev-parse", "--short", "HEAD"], ctx.cwd),
    runGit(["status", "--porcelain=v1", "--untracked-files=all"], ctx.cwd),
  ]);

  const gitLine =
    insideRepo === "true"
      ? `${branch || `detached@${head ?? "unknown"}`} · ${countChangedFiles(status)} changed files`
      : "not a git repository";

  const defaultModel = `${settings.defaultProvider ?? "unset"}/${settings.defaultModel ?? "unset"}`;
  const activeModel = formatModel(ctx);
  const thinking = pi.getThinkingLevel();
  const defaultThinking = settings.defaultThinkingLevel ?? "unset";

  return [
    "Session brief:",
    `- cwd: ${ctx.cwd}`,
    `- git: ${gitLine}`,
    `- model: ${activeModel}, reasoning ${thinking}`,
    `- configured default: ${defaultModel}, reasoning ${defaultThinking}`,
    `- packages: ${formatPackages(settings.packages)}`,
    "- memory: localmemory injects relevant hits per prompt when available; use memory_search for targeted recall and memory_save for durable decisions.",
    "- preferred tools:",
    "  - git/GitHub: git_inspect, gh_inspect",
    "  - files/search: read, edit, write, fd, rg",
    "  - code intelligence: symbol_search, module_report, read_symbol, read_enclosing, lsp_diagnostics, lens_diagnostics",
    "  - system diagnostics: service_inspect, docker_inspect, port_inspect, sqlite_query, openssl_inspect, gpg_inspect",
    "- safety: sudo is allowed for this dev machine; inspect first when possible; confirm destructive git, recursive deletion, secrets/prod config edits, and writes outside cwd.",
  ].join("\n");
}

export default function sessionBrief(pi: ExtensionAPI) {
  let latestBrief = "";

  async function refreshBrief(ctx: ExtensionContext) {
    latestBrief = await buildBrief(ctx, pi);
    if (ctx.hasUI) ctx.ui.setStatus("session-brief", "📋 brief");
    return latestBrief;
  }

  pi.on("session_start", async (_event, ctx) => {
    await refreshBrief(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const brief = latestBrief || (await refreshBrief(ctx));
    return {
      message: {
        customType: "session-brief",
        content: brief,
        display: false,
      },
      systemPrompt: `${event.systemPrompt}\n\n${brief}`,
    };
  });

  pi.registerCommand("session-brief", {
    description: "Show the current compact Pi operating brief",
    handler: async (_args, ctx) => {
      const brief = await refreshBrief(ctx);
      ctx.ui.notify(brief, "info");
    },
  });
}
