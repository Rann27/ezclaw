import { randomUUID } from "node:crypto";
import type { ApprovalMode } from "@ezclaw/core";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { approvalRules } from "../db/schema.js";
import { matchesRule } from "./shell.js";
import type { ApprovalNeed } from "./tools.js";

/** "Always allow" decisions, kept per workspace as the leading words of a command. */
export class ApprovalRules {
  constructor(private readonly db: Db) {}

  list(workspace: string): { id: string; pattern: string[] }[] {
    return this.db
      .select()
      .from(approvalRules)
      .where(eq(approvalRules.workspace, workspace))
      .all()
      .map((r) => ({ id: r.id, pattern: r.pattern }));
  }

  add(workspace: string, pattern: string[]) {
    if (!pattern.length) return;
    this.db
      .insert(approvalRules)
      .values({ id: randomUUID(), workspace, pattern, patternKey: JSON.stringify(pattern), createdAt: new Date() })
      .onConflictDoNothing()
      .run();
  }

  remove(workspace: string, id: string) {
    this.db.delete(approvalRules).where(and(eq(approvalRules.workspace, workspace), eq(approvalRules.id, id))).run();
  }

  allows(workspace: string, need: ApprovalNeed): boolean {
    if (!need.parsed) return false;
    return this.list(workspace).some((r) => matchesRule(need.parsed!, r.pattern));
  }
}

/** Whether a tool call may run now, or the owner has to decide first. */
export function decide(need: ApprovalNeed | null, mode: ApprovalMode, rules: ApprovalRules, workspace: string): "auto" | "ask" {
  if (!need) return "auto";
  if (need.alwaysAsk) return "ask";
  if (need.autoIn.includes(mode)) return "auto";
  if (rules.allows(workspace, need)) return "auto";
  return "ask";
}
