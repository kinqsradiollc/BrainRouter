/**
 * Dependency-free terminal vocabulary shared by presentation heads and
 * privileged hosts. Executable paths and process handles remain host-owned.
 */

export interface TerminalGeometry {
  cols: number;
  rows: number;
}

export interface TerminalShellView {
  id: string;
  label: string;
  description: string;
  isDefault: boolean;
}

export interface TerminalShellCatalogView {
  selected: string;
  shells: TerminalShellView[];
}

export interface TerminalOpenRequest {
  shellId: string;
  cols?: number;
  rows?: number;
}

export interface TerminalSessionView {
  id: string;
  reused: boolean;
  snapshot: string;
  start: number;
  next: number;
  alive: boolean;
  shellId: string;
  label: string;
}

export interface TerminalReadView {
  chunk: string;
  next: number;
  alive: boolean;
  dropped: number;
}

export interface TerminalWriteRequest {
  id: string;
  data: string;
}

export interface TerminalReadRequest {
  id: string;
  from: number;
}

export interface TerminalResizeRequest extends TerminalGeometry {
  id: string;
}

export interface TerminalKillRequest {
  id: string;
}

export interface TerminalMutationView {
  ok: boolean;
}
