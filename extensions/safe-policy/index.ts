import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const TOOL_GUIDANCE = `
## Omega safe operating policy

Prefer pi's read-only inspection tools before shelling out or mutating state:
- Git: use \`git_inspect\` for status, diff, staged diff, log, branch, changed files, and show. Do not run destructive git commands without explicit user confirmation.
- GitHub: use \`gh_inspect\` for PRs, issues, checks, and repo metadata.
- Files: use \`read\`, \`fd\`, and \`rg\` for discovery; use \`edit\` for precise changes and \`write\` only for new files or full rewrites.
- Diagnostics: use \`lsp_diagnostics\` before builds and \`lens_diagnostics mode=all\` before saying work is done.
- Services/system debugging: use \`service_inspect\`, \`port_inspect\`, \`docker_inspect\`, \`sqlite_query\`, \`openssl_inspect\`, and \`gpg_inspect\` for read-only diagnosis before mutating system state.
- Sudo is allowed on this dev machine when needed, especially for package-manager and system debugging workflows, but inspect first when a read-only pi tool exists.
- Warn before editing secrets, credentials, production config, or paths outside the current working directory/repo.
`;

const criticalGitPatterns = [
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b.*(?:-[^\s]*f|--force)/i,
  /\bgit\s+push\b.*(?:--force|-f\b|--force-with-lease)/i,
  /\bgit\s+checkout\s+(?:--\s*)?\.\s*$/i,
  /\bgit\s+restore\s+(?:--\s*)?\.\s*$/i,
];

const criticalRemovePatterns = [
  /\brm\s+(?:[^;&|]*\s)?-[^;&|]*r[^;&|]*f[^;&|]*(?:\s+|=)(?:\/|~|\$HOME)(?:\s|$|[;&|])/i,
  /\brm\s+(?:[^;&|]*\s)?-[^;&|]*r[^;&|]*f[^;&|]*(?:\s+|=)(?:\.\.?)(?:\s|$|[;&|])/i,
];

const confirmationPatterns = [
  {
    pattern: /\brm\s+(?:[^;&|]*\s)?-[^;&|]*r[^;&|]*f/i,
    reason: "recursive forced removal",
  },
  {
    pattern: /\b(?:sudo\s+)?systemctl\s+(?:restart|stop|disable|mask)\b/i,
    reason: "mutating systemd service state",
  },
  {
    pattern: /\b(?:chmod|chown)\s+[^;&|]*-R\b/i,
    reason: "recursive permission or owner change",
  },
  {
    pattern: /(?:^|\s)>\s*\/(?:etc|usr|var|boot)\b/i,
    reason: "writing to a system path",
  },
  {
    pattern: /\b(?:cp|mv|tee|install)\b[^;&|]*\s\/(?:etc|usr|var|boot)\b/i,
    reason: "mutating a system path",
  },
];

const protectedPathPatterns = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:\.env|\.envrc)$/i,
  /(^|\/)(?:id_rsa|id_ed25519|known_hosts)$/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /(?:secret|credential|token|password)/i,
  /(^|\/)(?:prod|production)[^/]*(?:\.json|\.yaml|\.yml|\.toml|\.env)$/i,
];

function normalizeCommand(command: unknown) {
  return typeof command === "string" ? command.trim() : "";
}

function trunc(value: string) {
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}

function normalizeFilePath(cwd: string, targetPath: string) {
  const parts = targetPath.startsWith("/")
    ? []
    : cwd.split("/").filter(Boolean);

  for (const part of targetPath.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }

  return `/${parts.join("/")}`;
}

function isInside(parent: string, child: string) {
  return child === parent || child.startsWith(`${parent.replace(/\/$/, "")}/`);
}

async function confirm(ctx: ExtensionContext, title: string, detail: string) {
  if (!ctx.hasUI) return false;
  const choice = await ctx.ui.select(`${title}\n\n${detail}\n\nAllow?`, [
    "Allow",
    "Block",
  ]);
  return choice === "Allow";
}

async function requireConfirmation(
  ctx: ExtensionContext,
  title: string,
  detail: string,
) {
  const allowed = await confirm(ctx, title, detail);
  if (!allowed)
    return { block: true, reason: `${title} blocked by safe-policy` };
  return undefined;
}

function getToolPath(input: Record<string, unknown>) {
  const value = input.path ?? input.file ?? input.filePath;
  return typeof value === "string" ? value : null;
}

function safePolicy(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${TOOL_GUIDANCE}`,
  }));

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "bash") {
      const command = normalizeCommand(
        (event.input as Record<string, unknown>).command,
      );
      if (!command) return undefined;

      const isCritical = [
        ...criticalGitPatterns,
        ...criticalRemovePatterns,
      ].some((pattern) => pattern.test(command));
      if (isCritical) {
        return requireConfirmation(
          ctx,
          "Critical destructive command",
          trunc(command),
        );
      }

      const matched = confirmationPatterns.find(({ pattern }) =>
        pattern.test(command),
      );
      if (matched) {
        return requireConfirmation(
          ctx,
          `Potentially risky shell command: ${matched.reason}`,
          trunc(command),
        );
      }

      return undefined;
    }

    if (!["write", "edit"].includes(event.toolName)) return undefined;

    const input = event.input as Record<string, unknown>;
    const targetPath = getToolPath(input);
    if (!targetPath) return undefined;

    const absoluteTargetPath = normalizeFilePath(ctx.cwd, targetPath);
    const outsideCwd = !isInside(
      normalizeFilePath("/", ctx.cwd),
      absoluteTargetPath,
    );
    const protectedPath = protectedPathPatterns.some((pattern) =>
      pattern.test(absoluteTargetPath),
    );

    if (!outsideCwd && !protectedPath) return undefined;

    const reasons = [
      outsideCwd ? `outside cwd (${ctx.cwd})` : null,
      protectedPath
        ? "matches secrets/credentials/production-config policy"
        : null,
    ].filter((reason): reason is string => Boolean(reason));

    return requireConfirmation(
      ctx,
      `Sensitive ${event.toolName} target`,
      `${targetPath}\n\nReason: ${reasons.join("; ")}`,
    );
  });
}

module.exports = safePolicy;
