import type { Ink, Surface } from "./jobs-model";

/** Ink → text colour token. Values come from the pen token table, not the Tailwind ramp. */
export const INK_TEXT: Record<Ink, string> = {
  foreground: "text-foreground",
  secondary: "text-text-secondary",
  muted: "text-text-muted",
  accent: "text-accent",
  info: "text-info",
  warning: "text-warning",
  success: "text-success",
  error: "text-error",
};

/** Surface → fill token (`$xai-bg`, `$xai-surface`, `$xai-*-bg`). */
export const SURFACE_BG: Record<Surface, string> = {
  background: "bg-background",
  surface: "bg-muted",
  card: "bg-card",
  secondary: "bg-secondary",
  "accent-bg": "bg-accent-bg",
  "info-bg": "bg-info-bg",
  "warning-bg": "bg-warning-bg",
  "success-bg": "bg-success-bg",
  "error-bg": "bg-error-bg",
};
