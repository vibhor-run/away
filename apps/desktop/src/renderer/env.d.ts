import type { AwayApi } from "../shared/api";

declare global {
  interface Window {
    away: AwayApi & { platform: string; onNavigate(listener: (route: string) => void): () => void };
  }
}
