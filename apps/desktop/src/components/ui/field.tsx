import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

/** 统一输入框（v2） */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...props }, ref) {
    return <input ref={ref} className={`field__input ${className}`.trim()} {...props} />;
  },
);

export interface FieldProps {
  label: ReactNode;
  helper?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** 表单字段包装（v2：label + helper + error） */
export function Field({ label, helper, error, required = false, hint, className = "", children }: FieldProps) {
  return (
    <div className={`field ${className}`.trim()}>
      <span className="field__label">
        {label}
        {required ? <span aria-hidden="true" className="req">*</span> : null}
      </span>
      {helper ? <small className="field__helper">{helper}</small> : null}
      {children}
      {hint}
      {error ? <small className="field__error">{error}</small> : null}
    </div>
  );
}
