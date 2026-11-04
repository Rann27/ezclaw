import { mcpModelName } from "@ezclaw/core";
import { z } from "zod";
import { define, ToolArgError, type ApprovalNeed, type ToolEnv, type ToolImpl } from "../agent/tools.js";
import { effectivePolicy, type McpCallResult, type McpService } from "./service.js";

type Row = ReturnType<McpService["row"]>;

const MAX_RESULT_CHARS = 200_000;

/** Turns an MCP tool result into text for the model; images ride along like view_image ones. */
export function resultText(res: McpCallResult, env: ToolEnv, label: string): string {
  const out: string[] = [];
  let images = 0;
  for (const c of res.content ?? []) {
    if (c.type === "text" && c.text) out.push(c.text);
    else if (c.type === "image" && c.data) {
      const shown = env.ext?.attachImageData?.(Buffer.from(c.data, "base64"), `${label} gambar ${images + 1}`);
      images++;
      out.push(shown ? `[gambar ${images} terlampir untuk dilihat]` : `[gambar ${images}: ${c.mimeType ?? "image"}, tampil untuk pemilik; model ini tidak bisa melihat gambar]`);
    } else if (c.type === "resource" && c.resource) {
      out.push(c.resource.text ?? `[resource ${c.resource.uri ?? ""} ${c.resource.mimeType ?? ""}]`);
    } else if (c.type === "resource_link") out.push(`[tautan resource] ${JSON.stringify(c).slice(0, 500)}`);
    else if (c.type === "audio") out.push("[audio, tidak ditampilkan]");
  }
  if (!out.length && res.structuredContent !== undefined) out.push(JSON.stringify(res.structuredContent, null, 2));
  const text = out.join("\n\n") || "(tool tidak mengembalikan isi)";
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[dipotong]` : text;
}

function needFor(mcp: McpService, row: Row, tool: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }, args: unknown): ApprovalNeed | null {
  const policy = effectivePolicy(row, tool);
  if (policy === "allow") return null;
  return {
    request: {
      kind: "mcp",
      title: `${row.name} · ${tool.name}`,
      server: row.name,
      tool: tool.name,
      args: JSON.stringify(args ?? {}, null, 2).slice(0, 6000),
      ...(tool.annotations?.destructiveHint ? { reason: "Server menandai tool ini bisa menghapus atau mengubah data." } : {}),
    },
    autoIn: policy === "ask" && row.toolPolicies[tool.name] === "ask" ? [] : ["full"],
    onAllowAlways: () => mcp.setToolPolicy(row.id, tool.name, "allow"),
  };
}

/** The model-facing tools of the given servers, skipping the ones the owner switched off. */
export async function mcpTools(mcp: McpService, rows: Row[]): Promise<ToolImpl[]> {
  const out: ToolImpl[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const tools = await mcp.toolsOf(row);
    for (const t of tools) {
      if (effectivePolicy(row, t) === "off") continue;
      const name = mcpModelName(row.name, t.name);
      if (seen.has(name)) continue;
      seen.add(name);
      const schema = t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} };
      out.push({
        name,
        readOnly: t.annotations?.readOnlyHint === true,
        def: { name, description: `[MCP ${row.name}] ${t.description ?? t.title ?? t.name}`.slice(0, 4000), parameters: { type: "object", ...schema } },
        prepare: (args, env) => ({
          need: needFor(mcp, row, t, args),
          async run() {
            const res = await mcp.callTool(row.id, t.name, args, env.signal);
            return { output: resultText(res, env, `${row.name}/${t.name}`), isError: res.isError === true };
          },
        }),
      });
    }
  }
  const withResources = rows.filter((r) => mcp.connection(r.id)?.hasResources);
  if (withResources.length) out.push(...resourceTools(mcp, withResources));
  return out;
}

function resourceTools(mcp: McpService, rows: Row[]): ToolImpl[] {
  const names = rows.map((r) => r.name);
  const pick = (server: string) => {
    const r = rows.find((x) => x.name.toLowerCase() === server.toLowerCase());
    if (!r) throw new ToolArgError(`Server "${server}" tidak punya resource yang tersedia. Pilihan: ${names.join(", ")}.`);
    return r;
  };
  return [
    define(
      "mcp_list_resources",
      `List the resources (documents, data) that MCP servers offer. Servers with resources: ${names.join(", ")}.`,
      z.object({ server: z.string().describe(`One of: ${names.join(", ")}`) }),
      true,
      (args) => ({
        need: null,
        async run() {
          const r = pick(args.server);
          const list = await mcp.listResources(r.id);
          if (!list.length) return { output: "(tidak ada resource)" };
          return { output: list.slice(0, 300).map((x) => `- ${x.uri}${x.name ? `  ${x.name}` : ""}${x.description ? ` — ${x.description}` : ""}`).join("\n") };
        },
      }),
    ),
    define(
      "mcp_read_resource",
      "Read one resource from an MCP server by its URI (from mcp_list_resources).",
      z.object({ server: z.string(), uri: z.string().min(1) }),
      true,
      (args, env) => {
        const r = pick(args.server);
        return {
          need: effectivePolicy(r, { name: "", annotations: { readOnlyHint: true } }) === "allow" ? null : { request: { kind: "mcp", title: `${r.name} · baca resource`, server: r.name, tool: "read_resource", args: args.uri }, autoIn: ["full", "edit"] },
          async run() {
            const contents = await mcp.readResource(r.id, args.uri, env.signal);
            return {
              output:
                contents
                  .map((c) => ("text" in c && typeof c.text === "string" ? c.text : `[data biner ${("mimeType" in c && c.mimeType) || ""}, ${"blob" in c && typeof c.blob === "string" ? Math.round((c.blob.length * 3) / 4) : 0} byte]`))
                  .join("\n\n")
                  .slice(0, MAX_RESULT_CHARS) || "(kosong)",
            };
          },
        };
      },
    ),
  ];
}
