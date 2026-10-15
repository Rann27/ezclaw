const OPEN = "<think>";
const CLOSE = "</think>";

export interface SplitChunk {
  kind: "text" | "reasoning";
  delta: string;
}

/**
 * Separates <think>...</think> from visible text in a stream. Local servers and some
 * providers inline reasoning this way, and a tag can be cut in half between chunks, so
 * a possible partial tag at the end of a chunk is held back until the next one.
 */
export class ThinkTagSplitter {
  private inThink = false;
  private pending = "";

  push(chunk: string): SplitChunk[] {
    const out: SplitChunk[] = [];
    let buffer = this.pending + chunk;
    this.pending = "";

    while (buffer.length > 0) {
      const tag = this.inThink ? CLOSE : OPEN;
      const at = buffer.indexOf(tag);
      if (at >= 0) {
        this.emit(out, buffer.slice(0, at));
        buffer = buffer.slice(at + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      const hold = partialSuffix(buffer, tag);
      this.emit(out, buffer.slice(0, buffer.length - hold));
      this.pending = buffer.slice(buffer.length - hold);
      break;
    }
    return out;
  }

  /** Emits whatever was held back once the stream ends. */
  flush(): SplitChunk[] {
    const out: SplitChunk[] = [];
    this.emit(out, this.pending);
    this.pending = "";
    return out;
  }

  private emit(out: SplitChunk[], delta: string) {
    if (delta) out.push({ kind: this.inThink ? "reasoning" : "text", delta });
  }
}

/** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
function partialSuffix(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (tag.startsWith(s.slice(s.length - len))) return len;
  }
  return 0;
}
