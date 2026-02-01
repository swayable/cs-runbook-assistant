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
