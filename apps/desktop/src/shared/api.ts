// The only API the window (renderer) can call. Implemented in preload.ts via IPC to main.ts.
import type { Project } from "@away/protocol";

export type RelayState = "connecting" | "online" | "offline";

export interface Status {
  relay: { state: RelayState; detail: string | null };
  laptopName: string;
  relayUrl: string;
}

export interface Device {
  id: string;
  name: string;
  pairedAt: string;
  revokedAt: string | null;
}

export interface SessionInfo {
  id: string;
  agent: string;
  projectId: string;
  status: "starting" | "idle" | "running" | "ended";
  createdAt: string;
}

export interface Pairing {
  offer: string;
  /** PNG data URL of the QR code. */
  qr: string;
  expiresAt: number;
}

export interface AwayApi {
  getStatus(): Promise<Status>;
  onStatus(listener: (status: Status) => void): () => void;
  listProjects(): Promise<Project[]>;
  /** Opens a folder picker. Resolves null if the user cancels. */
  addProject(): Promise<Project | null>;
  removeProject(id: string): Promise<void>;
  listDevices(): Promise<Device[]>;
  revokeDevice(id: string): Promise<void>;
  listSessions(): Promise<SessionInfo[]>;
  createPairing(): Promise<Pairing>;
  copyText(text: string): Promise<void>;
}

/** Requests forwarded from main.ts to the companion utility process. */
export type WorkerRequest =
  | { type: "info" }
  | { type: "pair" }
  | { type: "listProjects" }
  | { type: "addProject"; path: string }
  | { type: "removeProject"; id: string }
  | { type: "listDevices" }
  | { type: "revokeDevice"; id: string }
  | { type: "listSessions" }
  | { type: "stop" };

export type WorkerMessage =
  | { id: number; result?: unknown; error?: string }
  | { event: "relay"; state: RelayState; detail: string | null };
