import { Dialog } from "../Dialog";
import { useRequestLogs } from "../../lib/queries";

export function RequestLogDialog({ messageId, onClose }: { messageId: string | null; onClose: () => void }) {
  const { data, isPending, isError, error, refetch } = useRequestLogs(messageId);

  return (
    <Dialog open={messageId !== null} onClose={onClose} title="Request ke provider" width="max-w-3xl">
      {isPending && messageId && (
        <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
          <span className="node node-run" aria-hidden />
          Memuat request
        </p>
      )}
      {isError && (
        <div className="grid gap-2 rounded-sm bg-danger-soft p-3 text-ui text-danger-text" role="alert">
          <p>{error.message}</p>
          <button type="button" className="btn btn-secondary justify-self-start" onClick={() => void refetch()}>
            Coba lagi
          </button>
        </div>
      )}
      {data && data.logs.length === 0 && <p className="text-ui text-fg-2">Tidak ada catatan request untuk pesan ini. Catatan dihapus otomatis setelah 30 hari.</p>}
      <div className="grid gap-6">
        {data?.logs.map((log) => (
          <section key={log.attempt} aria-labelledby={`log-${log.attempt}`} className="grid gap-2">
            <h3 id={`log-${log.attempt}`} className="flex flex-wrap items-center gap-2 text-ui font-semibold">
              <span className={`node ${log.error || (log.status && log.status >= 400) ? "node-fail" : "node-done"}`} aria-hidden />
              Percobaan {log.attempt}
              <span className="font-normal text-fg-2">
                {log.status ?? "tanpa respons"}
                {log.durationMs !== null && `, ${(log.durationMs / 1000).toFixed(1)} dtk`}
              </span>
            </h3>
            <p className="break-all font-code text-dense">
              {log.method} {log.url}
            </p>
            <Block label="Header (kunci disembunyikan)" text={JSON.stringify(log.requestHeaders, null, 2)} />
            <Block label="Body" text={JSON.stringify(log.requestBody, null, 2)} />
            {log.responseText && <Block label={log.status && log.status >= 400 ? "Respons error" : "Ringkasan respons"} text={prettyIfJson(log.responseText)} />}
            {log.error && (
              <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
                {log.error}
              </p>
            )}
          </section>
        ))}
      </div>
    </Dialog>
  );
}

function prettyIfJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <details open className="rounded-sm border border-line">
      <summary className="cursor-pointer bg-sunken px-3 py-1.5 text-dense font-semibold">{label}</summary>
      <pre className="m-0 max-h-72 overflow-auto p-3 font-code text-dense whitespace-pre-wrap break-words">{text}</pre>
    </details>
  );
}
