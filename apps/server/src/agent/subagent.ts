import type { ApprovalMode, CanonicalMessage, ChatParams, Part } from "@ezclaw/core";
import { callModel, newAccumulator } from "../provider/call.js";
import { decide } from "./approvals.js";
import type { AgentDeps, RunHandle } from "./loop.js";
import { selectTools } from "./toolRegistry.js";
import { clipOutput, ToolArgError, type ToolEnv } from "./tools.js";
import { SUBAGENT_TOOLS, type ToolExtras } from "./toolsExtra.js";

const MAX_STEPS = 15;
const OUTPUT_LIMIT = 20_000;

const SUBAGENT_SYSTEM = `You are a research helper working for another agent. You can look at files in the workspace and read the web, but you cannot change anything. Investigate the task you are given, then answer with a concise, factual report: what you found, with file paths and line numbers or URLs as evidence, and what you could not determine. Do not ask questions; you will not get answers. Stop as soon as you can answer.`;

export interface SubagentInput {
  modelRowId: string;
  params: ChatParams;
  approvalMode: ApprovalMode;
  workspace: string;
  task: string;
  logMessageId: string;
  baseEnv: Omit<ToolEnv, "ask" | "ext">;
  extras: Omit<ToolExtras, "subagent">;
}

/**
 * A helper agent with its own, throw-away context. It may only read (files, web); anything that
 * needs permission still goes to the owner through the parent run. Returns its final report.
 */
export async function runSubagent(deps: AgentDeps, run: RunHandle, input: SubagentInput): Promise<string> {
  const tools = selectTools(SUBAGENT_TOOLS, input.baseEnv.shell);
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const messages: CanonicalMessage[] = [{ role: "user", parts: [{ type: "text", text: input.task }] }];
  const extras: ToolExtras = { ...input.extras, subagent: async () => "Subagent tidak bisa memanggil subagent lain." };
  let lastText = "";

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (run.signal.aborted) throw new Error("Dihentikan oleh pengguna.");
    const acc = newAccumulator();
    await callModel(
      deps,
      {
        modelRowId: input.modelRowId,
        params: input.params,
        system: SUBAGENT_SYSTEM,
        messages,
        tools: tools.map((t) => t.def),
        logMessageId: input.logMessageId,
        signal: run.signal,
        onText: () => {},
        onReasoning: () => {},
        onNote: () => {},
        onUsage: () => {},
      },
      acc,
    );
    const text = acc.text.join("");
    if (text) lastText = text;
    const parts: Part[] = [];
    if (text) parts.push({ type: "text", text });
    const calls = acc.toolCalls.map((c) => {
      let args: unknown = {};
      let argsError: string | undefined;
      try {
        args = JSON.parse(c.argsText || "{}");
      } catch (err) {
        argsError = err instanceof Error ? err.message : "JSON tidak valid";
      }
      return { callId: c.callId, name: c.name, args, argsError };
    });
    for (const c of calls) parts.push({ type: "tool_call", callId: c.callId, name: c.name, args: c.args, ...(c.argsError ? { argsError: c.argsError } : {}) });
    messages.push({ role: "assistant", parts, ...(acc.raw ? { raw: acc.raw } : {}) });
    if (!calls.length) return lastText || "(subagent tidak menulis laporan)";

    const results: Part[] = [];
    for (const c of calls) {
      const tool = toolMap.get(c.name);
      let output: string;
      let isError = false;
      try {
        if (!tool) throw new ToolArgError(`Tool "${c.name}" tidak tersedia untuk subagent.`);
        if (c.argsError) throw new ToolArgError(`Argumen bukan JSON yang valid (${c.argsError}).`);
        const env: ToolEnv = { ...input.baseEnv, ask: async () => "Subagent tidak bisa bertanya ke pengguna.", ext: extras };
        const prepared = tool.prepare(c.args, env);
        const need = prepared.need;
        if (need && decide(need, input.approvalMode, deps.rules, input.workspace) === "ask") {
          const answer = await run.approve({ ...need.request, title: `Subagent: ${need.request.title}` }, c.callId);
          if (answer.decision === "deny") throw new ToolArgError("Pengguna menolak izin untuk langkah subagent ini.");
        }
        run.emit({ type: "note", text: `Subagent: ${c.name} ${JSON.stringify(c.args).slice(0, 120)}` });
        const outcome = await prepared.run();
        output = outcome.output;
        isError = !!outcome.isError;
      } catch (err) {
        if (run.signal.aborted) throw err;
        output = err instanceof Error ? err.message : String(err);
        isError = true;
      }
      results.push({ type: "tool_result", callId: c.callId, name: c.name, output: clipOutput(output, OUTPUT_LIMIT).text, ...(isError ? { isError: true } : {}) });
    }
    messages.push({ role: "tool", parts: results });
  }
  return `${lastText}\n\n(Subagent berhenti setelah ${MAX_STEPS} langkah.)`.trim();
}
