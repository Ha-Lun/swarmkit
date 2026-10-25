// Mermaid diagrams for chat markdown: renders the code block
// immediately, then swaps in the sanitized SVG once the (lazily
// loaded) mermaid library finishes rendering. The SVG string comes
// only from mermaid itself (securityLevel 'strict' sanitizes it);
// innerHTML is never used for author-supplied content.
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';

const CODE_LIMIT = 20_000;

let mermaidInitialized = false;

export function Mermaid({ code }: { code: string }): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const rawId = useId();
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (code.length > CODE_LIMIT) return;
    let cancelled = false;
    const render = async (): Promise<void> => {
      try {
        const mod = await import('mermaid');
        const mermaid = mod.default;
        if (!mermaidInitialized) {
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
          mermaidInitialized = true;
        }
        const id = `mdmm-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
        const { svg } = await mermaid.render(id, code);
        if (cancelled) return;
        if (hostRef.current) hostRef.current.innerHTML = svg;
        setDone(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void render();
    return () => {
      cancelled = true;
    };
  }, [code, rawId]);

  if (code.length > CODE_LIMIT) {
    return (
      <div className="md-mermaid">
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="md-mermaid">
      {!done && (
        <pre>
          <code>{code}</code>
        </pre>
      )}
      <div ref={hostRef} className="md-mermaid-svg" aria-hidden={!done} />
      {failed && <span className="md-mermaid-error">diagram error</span>}
    </div>
  );
}
