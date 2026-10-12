// Plain, content-first look: neutral grays, system font, follows the phone's light/dark setting.
import { useColorScheme } from "react-native";

const light = {
  background: "#ffffff",
  surface: "#f4f4f4",
  surfacePressed: "#ececec",
  border: "#e5e5e5",
  text: "#0d0d0d",
  secondary: "#6b6b6b",
  tertiary: "#a3a3a3",
  primary: "#0d0d0d",
  onPrimary: "#ffffff",
  green: "#10a37f",
  amber: "#c27a00",
  red: "#d93025",
};

const dark: typeof light = {
  background: "#0f0f0f",
  surface: "#212121",
  surfacePressed: "#2a2a2a",
  border: "#2e2e2e",
  text: "#ececec",
  secondary: "#9b9b9b",
  tertiary: "#5f5f5f",
  primary: "#ececec",
  onPrimary: "#0d0d0d",
  green: "#19c37d",
  amber: "#e0a030",
  red: "#ef5350",
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}

export const AGENT_NAMES: Record<string, string> = { pi: "Pi", claude: "Claude Code", codex: "Codex" };

export function statusColor(theme: Theme, status: string): string {
  if (status === "running" || status === "connected") return theme.green;
  if (status === "starting" || status === "connecting" || status === "disconnected") return theme.amber;
  if (status === "rejected") return theme.red;
  return theme.tertiary;
}

export const mono = "Menlo";
