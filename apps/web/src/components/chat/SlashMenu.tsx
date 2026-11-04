import type { McpPromptInfo } from "@ezclaw/core";
import { useMemo } from "react";
import { useMcp, useSkills } from "../../lib/queries";

export type SlashItem =
  | { kind: "skill"; key: string; name: string; description: string }
  | { kind: "prompt"; key: string; name: string; description: string; serverId: string; server: string; prompt: McpPromptInfo };

/** What "/" offers in a composer: the skills a run here may use, and prompts of MCP servers on for this mode. */
export function useSlashItems(mode: "agent" | "chat", workspace = ""): SlashItem[] {
  const skills = useSkills(workspace);
  const mcp = useMcp();
  return useMemo(() => {
    const out: SlashItem[] = [];
    for (const s of skills.data?.skills ?? []) {
      if (!s.enabled || (mode === "chat" && !s.chat)) continue;
      out.push({ kind: "skill", key: `s:${s.id}`, name: s.name, description: s.description });
    }
    for (const srv of mcp.data?.servers ?? []) {
      if (!srv.enabled || !(mode === "agent" ? srv.agent : srv.chat) || srv.status !== "connected") continue;
      for (const p of srv.prompts) out.push({ kind: "prompt", key: `p:${srv.id}:${p.name}`, name: `${srv.name}:${p.name}`, description: p.description, serverId: srv.id, server: srv.name, prompt: p });
    }
    return out;
  }, [skills.data, mcp.data, mode]);
}

export interface SlashToken {
  /** The part a pick replaces: from the "/" to the caret, so text after the caret is never lost. */
  start: number;
  end: number;
  /** That part without the "/", in lower case. */
  query: string;
}

/**
 * The "/word" the caret is in, at the start of the text or after a space, else null.
 * A negative caret means a selection. "and/or" and "/usr/bin" are not words like this.
 */
export function slashQuery(text: string, caret: number): SlashToken | null {
  if (caret < 0) return null;
  const m = /(?:^|\s)\/([\w:-]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  if (text[caret] === "/") return null;
  return { start: caret - m[1]!.length - 1, end: caret, query: m[1]!.toLowerCase() };
}

export function filterSlash(items: SlashItem[], query: string): SlashItem[] {
  return items.filter((i) => i.name.toLowerCase().includes(query)).slice(0, 12);
}

export function SlashList({ id, items, active, onPick }: { id: string; items: SlashItem[]; active: number; onPick: (item: SlashItem) => void }) {
  return (
    <ul id={id} role="listbox" aria-label="Skill dan prompt" className="grid max-h-64 overflow-y-auto rounded-sm border border-line bg-surface py-1">
      {items.map((item, i) => (
        <li
          key={item.key}
          id={`${id}-${i}`}
          role="option"
          aria-selected={i === active}
          className={`grid cursor-pointer gap-0.5 px-3 py-1.5 ${i === active ? "bg-sunken" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
        >
          <span className="flex flex-wrap items-center gap-2 text-dense">
            <code className="font-semibold">/{item.name}</code>
            <span className="rounded-xs bg-sunken px-1.5 text-meta text-fg-2">{item.kind === "skill" ? "skill" : `prompt MCP`}</span>
          </span>
          {item.description && <span className="truncate text-meta text-fg-3">{item.description}</span>}
        </li>
      ))}
    </ul>
  );
}
