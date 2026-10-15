import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { highlight, resolveLang } from "../lib/highlight";

interface CodeBlockProps {
  code: string;
  lang: string | undefined;
  /** While the answer is still streaming the fence may be unfinished, so colouring waits. */
  streaming: boolean;
}

export function CodeBlock({ code, lang, streaming }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(0);

  useEffect(() => {
    if (streaming) return;
    let alive = true;
    highlight(code, lang)
      .then((h) => alive && setHtml(h))
      .catch(() => alive && setHtml(null));
    return () => {
      alive = false;
    };
  }, [code, lang, streaming]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  const label = resolveLang(lang) ?? lang ?? "teks";
  return (
    <div className="my-3 overflow-hidden rounded-md border border-line bg-sunken">
      <div className="flex items-center justify-between border-b border-line px-3 py-1">
        <span className="font-code text-meta text-fg-3">{label}</span>
        <button type="button" className="btn btn-ghost min-h-7 px-2 text-meta" onClick={() => void copy()} aria-label="Salin kode">
          {copied ? <CheckIcon size={14} aria-hidden /> : <CopyIcon size={14} aria-hidden />}
          {copied ? "Tersalin" : "Salin"}
        </button>
      </div>
      {html ? (
        <div className="code-scroll" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-scroll m-0 p-3 font-code text-dense leading-relaxed">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
