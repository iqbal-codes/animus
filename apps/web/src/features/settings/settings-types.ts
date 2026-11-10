import type { UserRound } from "lucide-react";
import type { Project } from "@animus/contracts/operator";
import type { Preferences } from "@/lib/preferences";

export type Scope = "personal" | "platform" | "project";

export type SectionId =
  | "preferences"
  | "providers"
  | "automation"
  | "github"
  | "system"
  | "models"
  | "checks"
  | "memory"
  | "releases";

export interface ScopeDefinition {
  id: Scope;
  label: string;
  icon: typeof UserRound;
  reach: string;
  boundary: string;
  defaultSection: SectionId;
  sections: { id: SectionId; label: string }[];
}

export interface SettingsModalProps {
  preferences: Preferences;
  projects?: Project[];
  currentProjectId?: string | null;
  initialScope?: Scope;
  initialSection?: SectionId;
  onSelectProject?: (projectId: string) => void;
  onSave: (next: Preferences) => void;
  onClose: () => void;
}
