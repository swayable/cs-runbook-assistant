// types/index.ts — Shared types

export type NotionBlock = any;

export type Chunk = {
  pageId: string;
  pageTitle: string;
  sectionTitle: string;
  text: string;
  url: string;
  ticketRefs: string[];
  codeSignals: number;
};

export type Ranked = { chunk: Chunk; score: number };

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state?: { name: string; type: string } | null;
};

export type IndexPayload = {
  builtAtMs: number;
  diag: any;
  chunks: Chunk[];
};

export type BuildOpts = {
  allowNotion?: boolean;
};

export type AnswerOpts = {
  includeLinear?: boolean;
  linearTimeoutMs?: number;
};

export type ActionPayload = {
  title: string;
  description: string;
  createdAt: number;
  consumedAt?: number;
};

// Classifier output types
export type Confidence = "high" | "medium" | "low";

export type EvidenceItem = {
  pageTitle: string;
  sectionTitle: string;
  url: string;
  excerpt: string;
};

export type ClassifierResult = {
  can_cs_handle: boolean;
  confidence: Confidence;
  reasons: string[];
  cs_safe_steps: string[];
  escalation_info_needed: string[];
  evidence: EvidenceItem[];
};

// Heuristic detection results
export type HeuristicSignals = {
  engineerRequired: boolean;
  csHandlable: boolean;
  engineerReasons: string[];
  csReasons: string[];
  detectedPatterns: {
    cli: string[];
    scripts: string[];
    database: string[];
    infra: string[];
    dangerous: string[];
    uiWorkflow: string[];
  };
};

// LLM summary result
export type LlmSummary = {
  summary: string;
  recommendation: "file_ticket" | "try_steps";
};

// Follow-up entry in thread state
export type FollowupEntry = {
  user: string;
  text: string;
  ts: number;
};

// Thread state for follow-up conversations
export type ThreadState = {
  channelId: string;
  threadTs: string;
  createdAt: number;
  rootQuestion: string;
  rootUser: string;
  followups: FollowupEntry[];
  lastHits: Ranked[];
  lastLlm: LlmSummary;
  ticketDraft: string;
};
