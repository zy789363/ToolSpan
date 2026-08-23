import type { ReactNode } from "react";

export interface CodeBlockProps {
  code: string;
  filename?: string;
  actions?: ReactNode;
  className?: string;
  showLineNumbers?: boolean;
}

/** 深色终端代码块（v2） */
export function CodeBlock({ code, filename, actions, className = "", showLineNumbers = false }: CodeBlockProps) {
  return (
    <div className={`code-block code-block--terminal ${className}`.trim()}>
      {filename || actions ? (
        <div className="code-block__head">
          <span className="code-block__file">{filename ?? ""}</span>
          {actions}
        </div>
      ) : null}
      <pre>
        {showLineNumbers
          ? code
              .split("\n")
              .map((line, i) => (
                <span key={i} className="code-block__ln">
                  <span className="code-block__ln-num">{i + 1}</span>
                  {line || " "}
                </span>
              ))
          : code}
      </pre>
    </div>
  );
}
