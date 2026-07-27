import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Type } from "typebox";

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const LOG_LIMIT_MAX = 1_000;

type ExecResult = {
  command: string;
  args: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

type ToolDetails = {
  command: string;
  code: number | null;
  truncated: boolean;
};

function cleanPath(path: string | undefined, cwd: string) {
  if (!path) return cwd;
  return resolve(cwd, path.startsWith("@") ? path.slice(1) : path);
}

function clamp(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  if (value === undefined) return fallback;
  return Math.max(min, Math.min(max, value));
}

function truncateText(text: string) {
  const lines = text.split("\n");
  const byLines = lines.length > MAX_LINES;
  let content = byLines ? lines.slice(0, MAX_LINES).join("\n") : text;
  const byBytes = Buffer.byteLength(content, "utf8") > MAX_BYTES;
  if (byBytes) content = content.slice(0, MAX_BYTES);
  return {
    content,
    truncated: byLines || byBytes,
    note:
      byLines || byBytes
        ? `\n\n[Output truncated to ${MAX_LINES} lines / ${MAX_BYTES} bytes.]`
        : "",
  };
}

function commandLine(command: string, args: string[]) {
  return [
    command,
    ...args.map((arg) => (/[\s"'`$]/.test(arg) ? JSON.stringify(arg) : arg)),
  ].join(" ");
}

function execFileLimited(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
) {
  return new Promise<ExecResult>((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let timedOut = false;

    const append = (current: string, chunk: Buffer) => {
      if (Buffer.byteLength(current, "utf8") >= MAX_BYTES * 2) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_BYTES * 2) truncated = true;
      return next.slice(0, MAX_BYTES * 2);
    };

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanupAbort();
      const out = truncateText(stdout);
      const err = truncateText(stderr);
      resolveResult({
        command,
        args,
        code,
        stdout: out.content + out.note,
        stderr: err.content + err.note,
        timedOut,
        truncated: truncated || out.truncated || err.truncated,
      });
    };

    const abort = () => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    };

    const timeout = setTimeout(abort, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const cleanupAbort = () =>
      options.signal?.removeEventListener("abort", abort);
    options.signal?.addEventListener("abort", abort, { once: true });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanupAbort();
      reject(error);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("close", finish);

    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    }
  });
}

async function runTool(
  command: string,
  args: string[],
  ctx: { cwd: string },
  signal: AbortSignal | undefined,
  options: {
    cwd?: string;
    input?: string;
    okCodes?: number[];
    timeoutMs?: number;
  } = {},
) {
  const result = await execFileLimited(command, args, {
    cwd: options.cwd ?? ctx.cwd,
    input: options.input,
    signal,
    timeoutMs: options.timeoutMs,
  });
  const okCodes = options.okCodes ?? [0];
  if (!okCodes.includes(result.code ?? -1)) {
    const errorText =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `exit code ${result.code}`;
    throw new Error(`${commandLine(command, args)} failed: ${errorText}`);
  }
  const text = [
    result.stdout.trimEnd(),
    result.stderr.trimEnd() && `stderr:\n${result.stderr.trimEnd()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    content: [{ type: "text" as const, text: text || "(no output)" }],
    details: {
      command: commandLine(command, args),
      code: result.code,
      truncated: result.truncated,
    } satisfies ToolDetails,
  };
}

function renderSimple(name: string) {
  return (
    args: Record<string, unknown>,
    theme: {
      fg(color: string, text: string): string;
      bold(text: string): string;
    },
  ) =>
    new Text(
      theme.fg("toolTitle", theme.bold(name)) +
        " " +
        theme.fg("dim", JSON.stringify(args)),
      0,
      0,
    );
}

function readOnlySql(sql: string) {
  const stripped = sql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim()
    .toLowerCase();
  if (!stripped) return false;
  if (
    /\b(insert|update|delete|drop|alter|create|replace|truncate|vacuum|attach|detach|reindex|analyze)\b/.test(
      stripped,
    )
  ) {
    return false;
  }
  return /^(select|with|pragma\s+(table_info|index_list|index_info|foreign_key_list|database_list|schema_version|user_version)\b)/.test(
    stripped,
  );
}

function registerGitInspect(pi: ExtensionAPI) {
  pi.registerTool({
    name: "git_inspect",
    label: "Git Inspect",
    description:
      "Read-only git inspection: status, diff, staged diff, log, branch, changed files, or show. Output is truncated to 50KB/2000 lines.",
    promptSnippet:
      "Inspect git state safely with git_inspect instead of ad-hoc git bash commands.",
    promptGuidelines: [
      "Use git_inspect for read-only git status, diffs, branches, changed files, and recent history.",
    ],
    parameters: Type.Object({
      action: StringEnum([
        "status",
        "diff",
        "staged_diff",
        "log",
        "branch",
        "changed_files",
        "show",
      ] as const),
      path: Type.Optional(
        Type.String({ description: "Repository path, defaults to cwd." }),
      ),
      ref: Type.Optional(
        Type.String({ description: "Revision/ref for show or log." }),
      ),
      file: Type.Optional(
        Type.String({ description: "Optional file path for diff/show." }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 200,
          description: "Log commit count.",
        }),
      ),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const cwd = cleanPath(params.path, ctx.cwd);
      const args = (() => {
        switch (params.action) {
          case "status":
            return ["status", "--short", "--branch"];
          case "diff":
            return ["diff", "--", ...(params.file ? [params.file] : [])];
          case "staged_diff":
            return [
              "diff",
              "--cached",
              "--",
              ...(params.file ? [params.file] : []),
            ];
          case "log":
            return [
              "log",
              "--oneline",
              "--decorate",
              `-${clamp(params.limit, 20, 1, 200)}`,
              ...(params.ref ? [params.ref] : []),
            ];
          case "branch":
            return ["branch", "--all", "--verbose", "--no-abbrev"];
          case "changed_files":
            return ["diff", "--name-status", "HEAD"];
          case "show":
            return [
              "show",
              "--stat",
              "--patch",
              params.ref ?? "HEAD",
              ...(params.file ? ["--", params.file] : []),
            ];
          default:
            throw new Error(`Unsupported git_inspect action: ${params.action}`);
        }
      })();
      return runTool("git", args, ctx, signal, { cwd });
    },
    renderCall: renderSimple("git_inspect"),
  });
}
function registerGhInspect(pi: ExtensionAPI) {
  pi.registerTool({
    name: "gh_inspect",
    label: "GitHub Inspect",
    description:
      "Read-only GitHub CLI inspection for PRs, issues, checks, and repo metadata. Requires gh auth. Output is truncated.",
    promptSnippet:
      "Use gh_inspect for read-only GitHub PR, issue, check, and repo inspection.",
    promptGuidelines: [
      "Use gh_inspect instead of gh in bash for read-only GitHub operations.",
    ],
    parameters: Type.Object({
      action: StringEnum([
        "pr_list",
        "pr_view",
        "pr_checks",
        "issue_list",
        "issue_view",
        "repo_view",
      ] as const),
      repo: Type.Optional(
        Type.String({ description: "OWNER/REPO, optional." }),
      ),
      number: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const repoArgs = params.repo ? ["--repo", params.repo] : [];
      const limit = String(clamp(params.limit, 20, 1, 100));
      const args = (() => {
        switch (params.action) {
          case "pr_list":
            return ["pr", "list", "--limit", limit, ...repoArgs];
          case "pr_view":
            return ["pr", "view", String(params.number ?? ""), ...repoArgs];
          case "pr_checks":
            return ["pr", "checks", String(params.number ?? ""), ...repoArgs];
          case "issue_list":
            return ["issue", "list", "--limit", limit, ...repoArgs];
          case "issue_view":
            return ["issue", "view", String(params.number ?? ""), ...repoArgs];
          case "repo_view":
            return ["repo", "view", ...(params.repo ? [params.repo] : [])];
          default:
            throw new Error(`Unsupported gh_inspect action: ${params.action}`);
        }
      })().filter(Boolean);
      return runTool("gh", args, ctx, signal);
    },
    renderCall: renderSimple("gh_inspect"),
  });
}
function registerJqQuery(pi: ExtensionAPI) {
  pi.registerTool({
    name: "jq_query",
    label: "jq Query",
    description:
      "Run a jq filter against a provided JSON string. Output is truncated.",
    promptSnippet:
      "Use jq_query to validate or transform JSON strings with jq.",
    parameters: Type.Object({
      input: Type.String(),
      filter: Type.String(),
      compact: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      return runTool(
        "jq",
        [params.compact ? "-c" : "-r", params.filter],
        ctx,
        signal,
        { input: params.input },
      );
    },
    renderCall: renderSimple("jq_query"),
  });
}
function registerSqliteQuery(pi: ExtensionAPI) {
  pi.registerTool({
    name: "sqlite_query",
    label: "SQLite Query",
    description:
      "Read-only SQLite inspection. Supports tables, schema, and safe SELECT/WITH/PRAGMA queries using sqlite3 -readonly.",
    promptSnippet: "Use sqlite_query for read-only SQLite database inspection.",
    promptGuidelines: [
      "Use sqlite_query for SQLite inspection; it rejects mutating SQL.",
    ],
    parameters: Type.Object({
      action: StringEnum(["tables", "schema", "query"] as const),
      dbPath: Type.String(),
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const db = cleanPath(params.dbPath, ctx.cwd);
      let sql = params.query;
      if (params.action === "tables") sql = ".tables";
      if (params.action === "schema") sql = ".schema";
      if (!sql) throw new Error("sqlite_query action=query requires query.");
      if (params.action === "query" && !readOnlySql(sql))
        throw new Error(
          "sqlite_query only allows read-only SELECT/WITH/safe PRAGMA statements.",
        );
      const limitedSql =
        params.action === "query" && params.limit
          ? `${sql.replace(/;\s*$/, "")} LIMIT ${params.limit};`
          : sql;
      return runTool(
        "sqlite3",
        ["-readonly", "-header", "-column", db, limitedSql],
        ctx,
        signal,
      );
    },
    renderCall: renderSimple("sqlite_query"),
  });
}
function registerPortInspect(pi: ExtensionAPI) {
  pi.registerTool({
    name: "port_inspect",
    label: "Port Inspect",
    description:
      "Inspect listening sockets and processes using ss/lsof. Read-only.",
    promptSnippet:
      "Use port_inspect to find what process is using a port or list listening sockets.",
    parameters: Type.Object({
      action: StringEnum(["listening", "port", "pid", "process"] as const),
      port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
      pid: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (params.action === "listening")
        return runTool("ss", ["-tulpn"], ctx, signal);
      if (params.action === "port") {
        if (!params.port)
          throw new Error("port_inspect action=port requires port.");
        return runTool("lsof", ["-nP", `-i:${params.port}`], ctx, signal, {
          okCodes: [0, 1],
        });
      }
      if (!params.pid)
        throw new Error(`port_inspect action=${params.action} requires pid.`);
      return runTool(
        "lsof",
        params.action === "pid"
          ? ["-p", String(params.pid)]
          : ["-Pan", "-p", String(params.pid), "-i"],
        ctx,
        signal,
        { okCodes: [0, 1] },
      );
    },
    renderCall: renderSimple("port_inspect"),
  });
}
function registerOpenSslInspect(pi: ExtensionAPI) {
  pi.registerTool({
    name: "openssl_inspect",
    label: "OpenSSL Inspect",
    description: "Certificate and TLS inspection using openssl. Read-only.",
    promptSnippet:
      "Use openssl_inspect for certificate expiry, fingerprints, and remote TLS probes.",
    parameters: Type.Object({
      action: StringEnum([
        "cert_file",
        "cert_remote",
        "tls_probe",
        "fingerprint",
      ] as const),
      path: Type.Optional(Type.String()),
      host: Type.Optional(Type.String()),
      port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
      serverName: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (params.action === "cert_file" || params.action === "fingerprint") {
        if (!params.path) throw new Error(`${params.action} requires path.`);
        const args = [
          "x509",
          "-in",
          cleanPath(params.path, ctx.cwd),
          "-noout",
          "-subject",
          "-issuer",
          "-dates",
          "-ext",
          "subjectAltName",
          ...(params.action === "fingerprint"
            ? ["-fingerprint", "-sha256"]
            : []),
        ];
        return runTool("openssl", args, ctx, signal);
      }
      if (!params.host) throw new Error(`${params.action} requires host.`);
      const port = params.port ?? 443;
      const serverName = params.serverName ?? params.host;
      const script =
        params.action === "tls_probe"
          ? `printf '' | openssl s_client -connect "$1:$2" -servername "$3" -brief 2>&1`
          : `printf '' | openssl s_client -connect "$1:$2" -servername "$3" -showcerts 2>/dev/null | openssl x509 -noout -subject -issuer -dates -ext subjectAltName -fingerprint -sha256`;
      return runTool(
        "bash",
        ["-lc", script, "--", params.host, String(port), serverName],
        ctx,
        signal,
      );
    },
    renderCall: renderSimple("openssl_inspect"),
  });
}
function registerGpgInspect(pi: ExtensionAPI) {
  pi.registerTool({
    name: "gpg_inspect",
    label: "GPG Inspect",
    description: "Read-only GPG key and signature inspection.",
    promptSnippet:
      "Use gpg_inspect for GPG key listing, fingerprints, and signature verification.",
    parameters: Type.Object({
      action: StringEnum([
        "list_keys",
        "show_key",
        "verify_signature",
        "fingerprint",
      ] as const),
      key: Type.Optional(Type.String()),
      signaturePath: Type.Optional(Type.String()),
      filePath: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (params.action === "list_keys")
        return runTool("gpg", ["--list-keys", "--fingerprint"], ctx, signal);
      if (params.action === "show_key" || params.action === "fingerprint") {
        if (!params.key) throw new Error(`${params.action} requires key.`);
        return runTool(
          "gpg",
          ["--show-keys", "--fingerprint", cleanPath(params.key, ctx.cwd)],
          ctx,
          signal,
        );
      }
      if (!params.signaturePath)
        throw new Error("verify_signature requires signaturePath.");
      return runTool(
        "gpg",
        [
          "--verify",
          cleanPath(params.signaturePath, ctx.cwd),
          ...(params.filePath ? [cleanPath(params.filePath, ctx.cwd)] : []),
        ],
        ctx,
        signal,
        { okCodes: [0, 1] },
      );
    },
    renderCall: renderSimple("gpg_inspect"),
  });
}
function registerClocSummary(pi: ExtensionAPI) {
  pi.registerTool({
    name: "cloc_summary",
    label: "cloc Summary",
    description: "Summarize codebase size using cloc. Output is truncated.",
    promptSnippet:
      "Use cloc_summary for codebase size summaries by language or file.",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
      action: StringEnum(["summary", "by_language", "by_file"] as const),
      excludeDir: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const args = [
        cleanPath(params.path, ctx.cwd),
        ...(params.action === "by_file" ? ["--by-file"] : []),
        ...(params.excludeDir ? [`--exclude-dir=${params.excludeDir}`] : []),
      ];
      return runTool("cloc", args, ctx, signal);
    },
    renderCall: renderSimple("cloc_summary"),
  });
}
function registerDirSummary(pi: ExtensionAPI) {
  pi.registerTool({
    name: "dir_summary",
    label: "Directory Summary",
    description:
      "Directory structure summaries using tree/eza. Output is truncated.",
    promptSnippet:
      "Use dir_summary when you need a compact directory tree, sizes, recent files, or top-level structure.",
    parameters: Type.Object({
      action: StringEnum(["tree", "sizes", "recent", "top_level"] as const),
      path: Type.Optional(Type.String()),
      depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const path = cleanPath(params.path, ctx.cwd);
      if (params.action === "tree")
        return runTool(
          "tree",
          ["-a", "-L", String(clamp(params.depth, 2, 1, 8)), path],
          ctx,
          signal,
          { okCodes: [0, 1] },
        );
      if (params.action === "sizes")
        return runTool("eza", ["-la", "--total-size", path], ctx, signal);
      if (params.action === "recent")
        return runTool("eza", ["-la", "--sort=modified", path], ctx, signal);
      return runTool(
        "eza",
        [
          "-la",
          "--tree",
          "--level",
          String(clamp(params.depth, 1, 1, 8)),
          path,
        ],
        ctx,
        signal,
      );
    },
    renderCall: renderSimple("dir_summary"),
  });
}
function registerServiceInspect(pi: ExtensionAPI) {
  pi.registerTool({
    name: "service_inspect",
    label: "Service Inspect",
    description:
      "Read-only systemctl/journalctl inspection for services, failed units, logs, and boot errors.",
    promptSnippet:
      "Use service_inspect for read-only systemd service and journal diagnostics.",
    promptGuidelines: [
      "Use service_inspect for service status/logs; it does not start, stop, restart, or enable units.",
    ],
    parameters: Type.Object({
      action: StringEnum([
        "failed_units",
        "service_status",
        "service_logs",
        "boot_errors",
        "user_services",
      ] as const),
      service: Type.Optional(Type.String()),
      lines: Type.Optional(
        Type.Integer({ minimum: 1, maximum: LOG_LIMIT_MAX }),
      ),
      user: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const scope = params.user ? ["--user"] : [];
      const lines = String(clamp(params.lines, 100, 1, LOG_LIMIT_MAX));
      if (params.action === "failed_units")
        return runTool(
          "systemctl",
          [...scope, "--failed", "--no-pager"],
          ctx,
          signal,
          { okCodes: [0, 1] },
        );
      if (params.action === "user_services")
        return runTool(
          "systemctl",
          ["--user", "list-units", "--type=service", "--no-pager"],
          ctx,
          signal,
          { okCodes: [0, 1] },
        );
      if (params.action === "boot_errors")
        return runTool(
          "journalctl",
          ["-p", "err", "-b", "-n", lines, "--no-pager"],
          ctx,
          signal,
          { okCodes: [0, 1] },
        );
      if (!params.service)
        throw new Error(`${params.action} requires service.`);
      if (params.action === "service_status")
        return runTool(
          "systemctl",
          [...scope, "status", params.service, "--no-pager"],
          ctx,
          signal,
          { okCodes: [0, 1, 3, 4] },
        );
      return runTool(
        "journalctl",
        [
          ...(params.user ? ["--user"] : []),
          "-u",
          params.service,
          "-n",
          lines,
          "--no-pager",
        ],
        ctx,
        signal,
        { okCodes: [0, 1] },
      );
    },
    renderCall: renderSimple("service_inspect"),
  });
}
function registerDockerInspect(pi: ExtensionAPI) {
  pi.registerTool({
    name: "docker_inspect",
    label: "Docker Inspect",
    description:
      "Read-only Docker inspection for containers, images, compose status, logs, inspect, ports, and volumes.",
    promptSnippet:
      "Use docker_inspect for read-only Docker/container diagnostics.",
    promptGuidelines: [
      "Use docker_inspect for Docker diagnostics; it does not run, exec, stop, remove, or restart containers.",
    ],
    parameters: Type.Object({
      action: StringEnum([
        "containers",
        "images",
        "compose_status",
        "logs",
        "inspect",
        "ports",
        "volumes",
      ] as const),
      target: Type.Optional(
        Type.String({
          description: "Container/image/name for logs, inspect, or ports.",
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: "Compose project directory, defaults to cwd.",
        }),
      ),
      lines: Type.Optional(
        Type.Integer({ minimum: 1, maximum: LOG_LIMIT_MAX }),
      ),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const cwd = cleanPath(params.path, ctx.cwd);
      if (params.action === "containers")
        return runTool("docker", ["ps", "-a"], ctx, signal);
      if (params.action === "images")
        return runTool("docker", ["images"], ctx, signal);
      if (params.action === "compose_status")
        return runTool("docker", ["compose", "ps"], ctx, signal, { cwd });
      if (params.action === "volumes")
        return runTool("docker", ["volume", "ls"], ctx, signal);
      if (!params.target) throw new Error(`${params.action} requires target.`);
      if (params.action === "logs")
        return runTool(
          "docker",
          [
            "logs",
            "--tail",
            String(clamp(params.lines, 100, 1, LOG_LIMIT_MAX)),
            params.target,
          ],
          ctx,
          signal,
          { okCodes: [0, 1] },
        );
      if (params.action === "inspect")
        return runTool("docker", ["inspect", params.target], ctx, signal);
      return runTool("docker", ["port", params.target], ctx, signal, {
        okCodes: [0, 1],
      });
    },
    renderCall: renderSimple("docker_inspect"),
  });
}

export default function localInspectTools(pi: ExtensionAPI) {
  registerGitInspect(pi);
  registerGhInspect(pi);
  registerJqQuery(pi);
  registerSqliteQuery(pi);
  registerPortInspect(pi);
  registerOpenSslInspect(pi);
  registerGpgInspect(pi);
  registerClocSummary(pi);
  registerDirSummary(pi);
  registerServiceInspect(pi);
  registerDockerInspect(pi);
}
