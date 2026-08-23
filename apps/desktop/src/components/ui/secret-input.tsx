import { forwardRef, useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";

export interface SecretInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {}

/** 密钥输入框（v2：眼睛切换明文；secret 不持久化） */
export const SecretInput = forwardRef<HTMLInputElement, SecretInputProps>(
  function SecretInput({ className = "", ...props }, ref) {
    const [visible, setVisible] = useState(false);
    return (
      <span className="secret-wrap">
        <input
          ref={ref}
          type={visible ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          className={`field__input ${className}`.trim()}
          {...props}
        />
        <button
          type="button"
          aria-label={visible ? "隐藏密钥" : "显示密钥"}
          onClick={() => setVisible((v) => !v)}
          className="secret-toggle"
        >
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </span>
    );
  },
);
