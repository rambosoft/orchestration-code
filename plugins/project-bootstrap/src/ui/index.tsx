import type { PluginDetailTabProps, PluginPageProps, PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { ErrorBoundary, useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import { PAGE_ROUTE } from "../manifest.js";
import { Review } from "./Review.js";
import { CSS } from "./styles.js";
import { Wizard } from "./Wizard.js";

const Styles = () => <style>{CSS}</style>;

/** Full page: the wizard. */
export function BootstrapPage({ context }: PluginPageProps) {
  return <ErrorBoundary><Styles /><Wizard context={context} /></ErrorBoundary>;
}

/** Project tab: the plan, its approval and what was created. */
export function BootstrapTab({ context }: PluginDetailTabProps) {
  return <ErrorBoundary><Styles /><Review context={context} /></ErrorBoundary>;
}

/** Sidebar entry. */
export function BootstrapNavLink(_props: PluginSidebarProps) {
  const nav = useHostNavigation();
  return <a {...nav.linkProps(`/${PAGE_ROUTE}`)} style={{ display: "block", padding: "6px 12px", color: "inherit", textDecoration: "none", fontSize: 14 }}>New AI project</a>;
}

/** Top bar button, visible on every page. */
export function BootstrapToolbarButton(_props: PluginSidebarProps) {
  const nav = useHostNavigation();
  return <a {...nav.linkProps(`/${PAGE_ROUTE}`)} style={{ fontSize: 13, padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border, #e4e4e7)", color: "inherit", textDecoration: "none", whiteSpace: "nowrap" }}>New AI project</a>;
}
