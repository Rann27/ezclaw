import type { ApprovalRequest } from "@ezclaw/core";
import { useId, useState } from "react";
import type { LiveApproval, LiveAsk } from "./useAgentRun";

const KIND_LABEL: Record<ApprovalRequest["kind"], string> = {
  shell: "Perintah shell",
  write: "Tulis file",
  edit: "Ubah file",
  outside: "Di luar workspace",
};

/** A unified diff with additions and removals marked by more than colour alone. */
export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="m-0 max-h-72 overflow-auto rounded-sm border border-line bg-raised py-2 font-code text-dense leading-relaxed" aria-label="Perubahan yang diusulkan">
      {lines.map((line, i) => {
        const add = line.startsWith("+") && !line.startsWith("+++");
        const del = line.startsWith("-") && !line.startsWith("---");
        const hunk = line.startsWith("@@") || line.startsWith("~~~") || line.startsWith("+++ ") || line.startsWith("--- ");
        return (
          <span
            key={i}
            className={["block px-3 whitespace-pre-wrap break-words", add ? "bg-brand-soft text-brand-soft-text" : del ? "bg-danger-soft text-danger-text" : hunk ? "text-fg-3" : "text-fg-2"].join(" ")}
          >
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

interface ApprovalProps {
  approval: LiveApproval;
  onDecide: (decision: "allow" | "allow_always" | "deny", reason?: string) => Promise<void>;
}

/** The one place the agent waits on the owner, so it uses the one accent colour. */
export function ApprovalPanel({ approval, onDecide }: ApprovalProps) {
  const { request } = approval;
  const reasonId = useId();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "allow" | "allow_always" | "deny") {
    setBusy(true);
    setError(null);
    try {
      await onDecide(decision, decision === "deny" ? reason.trim() || undefined : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Keputusan gagal dikirim.");
      setBusy(false);
    }
  }

  return (
    <section aria-label="Menunggu persetujuan" className="grid gap-3 rounded-md bg-ember-soft p-4">
      <h4 className="flex items-center gap-2 text-ui font-semibold text-ember-text">
        <span className="node node-wait" aria-hidden />
        Menunggu persetujuan
        <span className="rounded-xs bg-raised px-1.5 text-meta font-normal text-fg-2">{KIND_LABEL[request.kind]}</span>
      </h4>
      <p className="text-ui">{request.title}</p>
      {request.reason && <p className="rounded-sm bg-raised px-3 py-2 text-dense text-ember-text">{request.reason}</p>}
      {request.command && (
        <pre className="m-0 overflow-x-auto rounded-sm border border-line bg-raised p-3 font-code text-dense whitespace-pre-wrap break-words" aria-label="Perintah">
          {request.command}
        </pre>
      )}
      {request.cwd && request.kind === "shell" && (
        <p className="text-meta text-fg-2">
          Folder kerja: <code>{request.cwd}</code>
        </p>
      )}
      {request.path && !request.diff && (
        <p className="text-dense">
          Path: <code className="break-all">{request.path}</code>
        </p>
      )}
      {request.diff && <DiffView diff={request.diff} />}

      {denying ? (
        <div className="grid gap-2">
          <label htmlFor={reasonId} className="text-dense font-semibold">
            Alasan penolakan (dikirim ke model)
          </label>
          <input id={reasonId} autoFocus className="input" value={reason} maxLength={500} placeholder="Opsional, misalnya: jangan ubah file itu" onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void decide("deny")} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void decide("deny")}>
              Kirim penolakan
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setDenying(false)}>
              Kembali
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-approve" disabled={busy} onClick={() => void decide("allow")}>
            {request.kind === "shell" ? "Izinkan perintah" : "Izinkan perubahan"}
          </button>
          {request.rulePattern && (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void decide("allow_always")} title="Perintah yang diawali kata-kata ini tidak akan ditanyakan lagi di workspace ini">
              Selalu izinkan: <code className="ml-1">{request.rulePattern.join(" ")}</code>
            </button>
          )}
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setDenying(true)}>
            Tolak
          </button>
        </div>
      )}
      {error && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

interface AskProps {
  ask: LiveAsk;
  onAnswer: (answer: string) => Promise<void>;
}

export function AskPanel({ ask, onAnswer }: AskProps) {
  const inputId = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(answer: string) {
    if (!answer.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onAnswer(answer.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Jawaban gagal dikirim.");
      setBusy(false);
    }
  }

  return (
    <section aria-label="Pertanyaan dari agent" className="grid gap-3 rounded-md bg-ember-soft p-4">
      <h4 className="flex items-center gap-2 text-ui font-semibold text-ember-text">
        <span className="node node-wait" aria-hidden />
        Agent bertanya
      </h4>
      <p className="text-body">{ask.question}</p>
      {ask.options && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Pilihan jawaban">
          {ask.options.map((o) => (
            <button key={o} type="button" className="btn btn-secondary" disabled={busy} onClick={() => void submit(o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(text);
        }}
      >
        <label htmlFor={inputId} className="text-dense font-semibold">
          {ask.options ? "Atau jawab dengan kata-katamu" : "Jawabanmu"}
        </label>
        <div className="flex flex-wrap gap-2">
          <input id={inputId} className="input min-w-48 flex-1" value={text} onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="btn btn-approve" disabled={busy || !text.trim()}>
            Kirim jawaban
          </button>
        </div>
      </form>
      {error && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
