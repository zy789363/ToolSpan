import { useState, type ReactNode } from "react";
import { LockKeyhole } from "lucide-react";

import { SecretInput } from "./secret-input";

export interface ConfirmPhraseProps {
  phrase: string;
  onConfirmed: () => void;
  prompt?: ReactNode;
  className?: string;
  confirmLabel?: string;
}

/** 高风险操作确认短语（v2：Global Key 等） */
export function ConfirmPhrase({
  phrase,
  onConfirmed,
  prompt,
  className = "",
  confirmLabel = "继续",
}: ConfirmPhraseProps) {
  const [value, setValue] = useState("");
  const match = value.trim().toLowerCase() === phrase.toLowerCase();
  return (
    <div className={`confirm-phrase ${className}`.trim()}>
      <div className="confirm-phrase__title">
        <LockKeyhole size={14} />
        高风险操作确认
      </div>
      <p className="confirm-phrase__text">
        {prompt ?? (
          <>
            请输入短语 <code>{phrase}</code> 以确认你理解此操作的后果：
          </>
        )}
      </p>
      <SecretInput
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={`输入 ${phrase}`}
        aria-label="确认短语"
      />
      {match ? <div className="confirm-phrase__ok">✓ 短语匹配，可以继续</div> : null}
      <button type="button" disabled={!match} onClick={onConfirmed} className="button button--danger button--normal" style={{ alignSelf: "flex-start" }}>
        {confirmLabel}
      </button>
    </div>
  );
}
