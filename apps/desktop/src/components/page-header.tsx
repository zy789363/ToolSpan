interface PageHeaderProps {
  eyebrow: string;
  /** v2：eyebrow 前缀图标 */
  eyebrowIcon?: React.ReactNode;
  title: string;
  description: string;
  actions?: React.ReactNode;
}

export function PageHeader({ eyebrow, eyebrowIcon, title, description, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">
          {eyebrowIcon ? <span className="eyebrow__icon" aria-hidden="true">{eyebrowIcon}</span> : null}
          {eyebrow}
        </p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {actions === undefined ? null : <div className="page-actions">{actions}</div>}
    </header>
  );
}
