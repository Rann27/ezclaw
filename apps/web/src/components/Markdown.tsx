import { Children, isValidElement, memo, type ReactElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { CodeBlock } from "./CodeBlock";
import "katex/dist/katex.min.css";

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

function makeComponents(streaming: boolean): Components {
  return {
    pre({ children }) {
      const child = Children.toArray(children)[0];
      if (isValidElement(child)) {
        const el = child as ReactElement<{ className?: string; children?: unknown }>;
        const lang = /language-([\w+#-]+)/.exec(el.props.className ?? "")?.[1];
        const code = String(el.props.children ?? "").replace(/\n$/, "");
        return <CodeBlock code={code} lang={lang} streaming={streaming} />;
      }
      return <pre>{children}</pre>;
    },
    a({ href, children }) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
    // A remote image would let a model leak the conversation through its URL, so none is fetched.
    img({ src, alt }) {
      return (
        <span className="inline-flex flex-wrap items-center gap-1 rounded-xs bg-sunken px-1.5 py-0.5 text-dense text-fg-2">
          Gambar eksternal tidak dimuat{alt ? `: ${alt}` : ""}
          {src && (
            <a href={src} target="_blank" rel="noopener noreferrer" className="break-all">
              {src}
            </a>
          )}
        </span>
      );
    },
    table({ children }) {
      return (
        <div className="my-3 overflow-x-auto">
          <table>{children}</table>
        </div>
      );
    },
  };
}

const COMPONENTS = { streaming: makeComponents(true), done: makeComponents(false) };

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="prose-ez">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={streaming ? COMPONENTS.streaming : COMPONENTS.done}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
