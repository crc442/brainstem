// GateAction is exported from @brainstem/core, not re-exported by @brainstem/reflexes.
import type { GateAction } from "@brainstem/core";
import type { PulseDecision, SteerDecision } from "@brainstem/reflexes";

export interface PingRequest {
  kind: "ping";
}
export interface PingResponse {
  kind: "ping";
}

export interface ReviewActionRequest {
  kind: "reviewAction";
  tool: string;
  input: Record<string, unknown>;
  task: string;
  permissionMode?: string;
  toolUseId?: string;
}
export interface ReviewActionResponse {
  kind: "reviewAction";
  /** `skip` is no decision: the harness applies the user's own rules and permission mode. */
  action: GateAction | "skip";
  reasons: string[];
  mode: "off" | "shadow" | "active";
  wrap?: { command: string };
}

export interface PrepareMessageRequest {
  kind: "prepareMessage";
  message: string;
  taskId: string;
}
export interface PrepareMessageResponse {
  kind: "prepareMessage";
  action: GateAction | "skip";
  reasons: string[];
  recommendedIds?: string[];
}

export interface ObserveRequest {
  kind: "observe";
  /** `wrapper` output is reviewed before delivery; `hook` output is already in context. */
  source: "wrapper" | "hook";
  tool: string;
  action: string;
  text: string;
  status: "ok" | "error";
  exitCode?: number;
  signal?: string;
  complete: boolean;
  toolUseId?: string;
  command?: string;
}
export interface ObserveResponse {
  kind: "observe";
  /** Delivered text after Sanitize and Verify, printed by the wrapper. */
  text?: string;
  sanitize?: { action: "pass" | "review" | "block"; reasons: string[] };
  verify?: { action: "ok" | "mismatch"; reasons: string[] };
}

/** One PostToolBatch: a tool turn, the hook equivalent of the Pi adapter's turn. */
export interface BatchRequest {
  kind: "batch";
  toolUseIds: string[];
}
export interface BatchResponse {
  kind: "batch";
  pulse?: PulseDecision;
}

export interface CheckpointRequest {
  kind: "checkpoint";
}
export interface CheckpointResponse {
  kind: "checkpoint";
  pulse?: PulseDecision;
  steer?: SteerDecision;
}

export interface ShutdownRequest {
  kind: "shutdown";
}
export interface ShutdownResponse {
  kind: "shutdown";
}

export interface ErrorResponse {
  kind: "error";
  message: string;
}

export type Request =
  | PingRequest
  | ReviewActionRequest
  | PrepareMessageRequest
  | ObserveRequest
  | BatchRequest
  | CheckpointRequest
  | ShutdownRequest;
export type Response =
  | PingResponse
  | ReviewActionResponse
  | PrepareMessageResponse
  | ObserveResponse
  | BatchResponse
  | CheckpointResponse
  | ShutdownResponse
  | ErrorResponse;
