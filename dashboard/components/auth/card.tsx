import { appName } from "@/runport.config";
import { type Appearance, resolveAppearance } from "./appearance";

// The frame every auth screen shares: logo, title, subtitle, body and footer.
// Pure markup, so both server and client components can render it.

type CardProps = {
  appearance?: Appearance;
  title: string;
  subtitle?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
};

export function AuthCard({ appearance, title, subtitle, footer, children }: CardProps) {
  const { style, layout, cls } = resolveAppearance(appearance);
  return (
    <main className={cls("root", "rp-page")} style={style}>
      <div className={cls("card")} data-variant={layout.card}>
        <header className={cls("header")}>
          <div className={cls("logo")} aria-hidden="true">
            {layout.logoUrl ? <img src={layout.logoUrl} alt="" /> : appName.trim().charAt(0).toUpperCase()}
          </div>
          <h1 className={cls("title")}>{title}</h1>
          {subtitle && <p className={cls("subtitle")}>{subtitle}</p>}
        </header>
        <div className="rp-body">{children}</div>
        {footer && <p className={cls("footer")}>{footer}</p>}
      </div>
    </main>
  );
}

export function Message({ appearance, error, notice }: { appearance?: Appearance; error?: string; notice?: string }) {
  const { cls } = resolveAppearance(appearance);
  if (error) return <p role="alert" className={cls("alert")}>{error}</p>;
  if (notice) return <p role="status" className={cls("notice")}>{notice}</p>;
  return null;
}

export function Divider({ appearance }: { appearance?: Appearance }) {
  return <div className={resolveAppearance(appearance).cls("divider")}>or</div>;
}
