import type { ToolDef } from "@ezclaw/core";
import type { ShellKind } from "./shell.js";
import { allTools, type ToolImpl } from "./tools.js";
import { EXTRA_TOOLS } from "./toolsExtra.js";

/** Every tool EZClaw can offer, in the order the profile editor lists them. */
export function everyTool(shell: ShellKind): ToolImpl[] {
  return [...allTools(shell), ...EXTRA_TOOLS];
}

export const TOOL_NAMES = everyTool("bash").map((t) => t.name);

const WINDOWS_SHELL_GUIDANCE = `Windows safety rules:
- Do not compose destructive filesystem commands across shells. Do not enumerate paths in PowerShell and then pass them to \`cmd /c\`, batch builtins, or another shell for deletion or moving. Use one shell end-to-end, prefer native PowerShell cmdlets such as \`Remove-Item\` / \`Move-Item\` with \`-LiteralPath\`, and avoid string-built shell commands for file operations.
- Before any recursive delete or move on Windows, verify the resolved absolute target paths stay within the intended workspace or explicitly named target directory. Never issue a recursive delete or move against a computed path if the final target has not been checked.
- When using \`Start-Process\` to launch a background helper or service, pass \`-WindowStyle Hidden\` unless the user explicitly asked for a visible interactive window. Use visible windows only for interactive tools the user needs to see or control.`;

/**
 * Tool definitions as Codex presents them (codex-rs/core/src/tools/handlers/*_spec.rs, Apache-2.0),
 * for profiles with toolStyle "codex". EZClaw still runs its own implementation behind each name;
 * parameters EZClaw has no use for (tty, login, sandbox_permissions) are accepted and ignored.
 */
function codexDef(name: string, shell: ShellKind): ToolDef | null {
  if (name === "exec_command") {
    const yieldDesc =
      shell === "powershell"
        ? "Maximum time to wait before returning a session ID for a still-running command. Commands that finish sooner return immediately. For ordinary commands, omit this parameter to use the 10000 ms default. Effective range on Windows is 10000-30000 ms."
        : "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.";
    return {
      name,
      description: `Runs a command in a PTY, returning output or a session ID for ongoing interaction.${shell === "powershell" ? `\n\n${WINDOWS_SHELL_GUIDANCE}` : ""}`,
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string", description: "Shell command to execute." },
          justification: { type: "string", description: "User-facing approval question for `require_escalated`; omit otherwise." },
          login: { type: "boolean", description: "True runs the shell with -l/-i semantics; false disables them. Defaults to true." },
          max_output_tokens: { type: "number", description: "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy." },
          prefix_rule: { type: "array", items: { type: "string" }, description: "Optional command prefix the user may approve for similar commands." },
          sandbox_permissions: { type: "string", enum: ["use_default", "require_escalated"], description: "Per-command sandbox override. Defaults to `use_default`; use `require_escalated` for unsandboxed execution." },
          shell: { type: "string", description: "Shell binary to launch. Defaults to the user's default shell." },
          tty: { type: "boolean", description: "True allocates a PTY for the command; false or omitted uses plain pipes." },
          workdir: { type: "string", description: "Working directory for the command. Defaults to the turn cwd." },
          yield_time_ms: { type: "number", description: yieldDesc },
        },
        required: ["cmd"],
        additionalProperties: false,
      },
    };
  }
  if (name === "update_plan") {
    return {
      name,
      description: "Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.\n",
      parameters: {
        type: "object",
        properties: {
          explanation: { type: "string", description: "Optional explanation for this plan update." },
          plan: {
            type: "array",
            description: "The list of steps",
            items: {
              type: "object",
              properties: { step: { type: "string", description: "Task step text." }, status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Step status." } },
              required: ["step", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["plan"],
        additionalProperties: false,
      },
    };
  }
  if (name === "view_image") {
    return {
      name,
      description: "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Local filesystem path to an image file." } }, required: ["path"], additionalProperties: false },
    };
  }
  return null;
}

export function selectTools(names: string[], shell: ShellKind, style: "ezclaw" | "codex" = "ezclaw"): ToolImpl[] {
  const all = new Map(everyTool(shell).map((t) => [t.name, t]));
  return names.flatMap((n) => {
    const t = all.get(n);
    if (!t) return [];
    const def = style === "codex" ? codexDef(n, shell) : null;
    return [def ? { ...t, def } : t];
  });
}
