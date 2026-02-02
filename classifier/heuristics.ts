// classifier/heuristics.ts — Deterministic pattern detection for engineer vs CS classification
//
// These checks run BEFORE any LLM call and cannot be overridden by the LLM.

import type { HeuristicSignals, Chunk } from "../types/index.ts";

// ============================================================================
// Engineer-required patterns (if ANY match, mark as engineer_required)
// ============================================================================

// CLI / shell indicators
const CLI_PATTERNS = [
  /\bkubectl\b/i,
  /\bbash\b/i,
  /\bzsh\b/i,
  /\bssh\b/i,
  /\bterminal\b/i,
  /\bcurl\s+/i,
  /\bpip\s+install\b/i,
  /\bnpm\s+(install|run|exec)\b/i,
  /\bbrew\s+/i,
  /\bapt(-get)?\s+/i,
  /\bmake\s+/i,
  /\bpython\s+[\w\/\.]+\.py\b/i,
  /\bpython3?\s+-/i,
  /\bnode\s+[\w\/\.]+\.js\b/i,
  /\bdeno\s+(run|task)\b/i,
  /\byarn\s+(install|run)\b/i,
  /\bpnpm\s+/i,
  /\bchmod\s+/i,
  /\bsudo\s+/i,
  /\bexport\s+\w+=/i,
  /\benv\s+\w+=/i,
  /^\s*\$\s+/m, // Shell prompt
  /```(bash|sh|shell|zsh)/i,
];

// Scripts / jobs patterns
const SCRIPT_PATTERNS = [
  /\brun\s+(the\s+)?script\b/i,
  /\bmigration\b/i,
  /\bbackfill\b/i,
  /\bcron\s*(job)?\b/i,
  /\bcelery\b/i,
  /\bworker\b/i,
  /\bqueue\b/i,
  /\bdeploy(ment)?\b/i,
  /\brestart\s+(the\s+)?service\b/i,
  /\bjob\s+(script|runner)\b/i,
  /\bscheduled\s+task\b/i,
  /\.py\s*$/m,
  /\.sh\s*$/m,
  /\bexecute\s+(script|command)\b/i,
  /\brun\s+locally\b/i,
];

// Database operations
const DATABASE_PATTERNS = [
  /\bmongo\s*shell\b/i,
  /\bpsql\b/i,
  /\bsql\b/i,
  /\bupdateMany\b/i,
  /\bupdateOne\b/i,
  /\bdeleteMany\b/i,
  /\bdeleteOne\b/i,
  /\binsertMany\b/i,
  /\bObjectId\s*\(/i,
  /\baggregate\s*\(/i,
  /\bdb\.\w+\.\w+\(/i,
  /\bfind\s*\(\s*\{/i,
  /\.toArray\s*\(/i,
  /\bcompass\b/i,
  /\bmongoose\b/i,
  /\bprisma\b/i,
  /\bSELECT\s+.*\s+FROM\b/i,
  /\bUPDATE\s+.*\s+SET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bINSERT\s+INTO\b/i,
  /\bALTER\s+TABLE\b/i,
  /```(mongo|sql|postgresql)/i,
];

// Infra / access control
const INFRA_PATTERNS = [
  /\bAWS\b/,
  /\bGCP\b/,
  /\bIAM\b/,
  /\bsecrets?\b/i,
  /\bproduction\s+console\b/i,
  /\bk8s\b/i,
  /\bkubernetes\b/i,
  /\bECS\b/,
  /\bCloudWatch\b/i,
  /\bS3\s+bucket\b/i,
  /\bEC2\b/,
  /\bLambda\b/,
  /\bterraform\b/i,
  /\bansible\b/i,
  /\bdocker\b/i,
  /\bhelm\b/i,
  /\bvault\b/i,
  /\bSSH\s+key\b/i,
  /\bAPI\s+key\b/i,
  /\baccess\s+token\b/i,
  /\benv(ironment)?\s+var(iable)?s?\b/i,
];

// Dangerous verbs
const DANGEROUS_PATTERNS = [
  /\bdelete\s+production\b/i,
  /\bdrop\s+(table|database|collection)\b/i,
  /\btruncate\b/i,
  /\bmodify\s+production\s+data\b/i,
  /\bdisable\s+safeguards?\b/i,
  /\bforce\s+delete\b/i,
  /\bhard\s+reset\b/i,
  /\brollback\b/i,
  /\bpurge\b/i,
  /\bwipe\b/i,
  /\bdestroy\b/i,
  /\bnuke\b/i,
  /\bremove\s+all\b/i,
  /\bclear\s+(all|data|cache)\b/i,
  /--force\b/i,
  /-f\s*$/m,
];

// ============================================================================
// CS-handlable patterns (positive signals)
// ============================================================================

const UI_WORKFLOW_PATTERNS = [
  /\bclick\s+(on\s+)?(the\s+)?["']?\w+["']?\s*(button|link|tab)?\b/i,
  /\bopen\s+(the\s+)?\w+\s*(page|dashboard|ui|admin|panel|settings|diagnostics)\b/i,
  /\bnavigate\s+to\b/i,
  /\bin\s+the\s+admin\s*(ui|panel|dashboard)?\b/i,
  /\bdashboard\b/i,
  /\bsettings\s+page\b/i,
  /\bdiagnostics\s+page\b/i,
  /\bcopy\s+(the\s+)?link\b/i,
  /\bscreenshot\b/i,
  /\brefresh\s+(the\s+)?page\b/i,
  /\bretry\b/i,
  /\bre-?run\s+(the\s+)?analysis\b/i,
  /\bvia\s+(the\s+)?ui\b/i,
  /\bselect\s+(the\s+)?\w+\s+from\s+(the\s+)?dropdown\b/i,
  /\btoggle\s+(the\s+)?\w+\b/i,
  /\bcheck\s+(the\s+)?checkbox\b/i,
  /\bfill\s+(in|out)\s+(the\s+)?form\b/i,
  /\bsubmit\s+(the\s+)?form\b/i,
  /\bdownload\s+(the\s+)?(report|file|csv|pdf)\b/i,
  /\bexport\s+(the\s+)?(data|report)\b/i,
  /\bupload\s+(a|the)?\s*(file|image|document)\b/i,
  /\bview\s+(the\s+)?(details|info|status)\b/i,
  /\bsearch\s+for\b/i,
  /\bfilter\s+by\b/i,
  /\bsort\s+by\b/i,
];

// ============================================================================
// Detection functions
// ============================================================================

function findMatches(text: string, patterns: RegExp[]): string[] {
  const matches: string[] = [];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      // Extract a short context around the match
      const idx = text.indexOf(match[0]);
      const start = Math.max(0, idx - 20);
      const end = Math.min(text.length, idx + match[0].length + 20);
      const context = text.slice(start, end).replace(/\s+/g, " ").trim();
      matches.push(context);
    }
  }
  return matches;
}

export function detectHeuristics(chunks: Chunk[]): HeuristicSignals {
  const allText = chunks.map((c) => c.text).join("\n");

  const detectedPatterns = {
    cli: findMatches(allText, CLI_PATTERNS),
    scripts: findMatches(allText, SCRIPT_PATTERNS),
    database: findMatches(allText, DATABASE_PATTERNS),
    infra: findMatches(allText, INFRA_PATTERNS),
    dangerous: findMatches(allText, DANGEROUS_PATTERNS),
    uiWorkflow: findMatches(allText, UI_WORKFLOW_PATTERNS),
  };

  const engineerReasons: string[] = [];
  const csReasons: string[] = [];

  // Engineer-required signals
  if (detectedPatterns.cli.length > 0) {
    engineerReasons.push(`CLI/shell commands detected: "${detectedPatterns.cli[0]}"`);
  }
  if (detectedPatterns.scripts.length > 0) {
    engineerReasons.push(`Script/job execution required: "${detectedPatterns.scripts[0]}"`);
  }
  if (detectedPatterns.database.length > 0) {
    engineerReasons.push(`Database operations detected: "${detectedPatterns.database[0]}"`);
  }
  if (detectedPatterns.infra.length > 0) {
    engineerReasons.push(`Infrastructure/access control operations: "${detectedPatterns.infra[0]}"`);
  }
  if (detectedPatterns.dangerous.length > 0) {
    engineerReasons.push(`Dangerous operation detected: "${detectedPatterns.dangerous[0]}"`);
  }

  // CS-handlable signals
  if (detectedPatterns.uiWorkflow.length > 0) {
    csReasons.push(`UI workflow steps found: "${detectedPatterns.uiWorkflow[0]}"`);
  }

  const engineerRequired = engineerReasons.length > 0;
  const csHandlable = csReasons.length > 0 && !engineerRequired;

  return {
    engineerRequired,
    csHandlable,
    engineerReasons,
    csReasons,
    detectedPatterns,
  };
}

// Check a single chunk for heuristics (useful for filtering)
export function chunkHasEngineerSignals(chunk: Chunk): boolean {
  const text = chunk.text;
  const allPatterns = [
    ...CLI_PATTERNS,
    ...SCRIPT_PATTERNS,
    ...DATABASE_PATTERNS,
    ...INFRA_PATTERNS,
    ...DANGEROUS_PATTERNS,
  ];
  return allPatterns.some((p) => p.test(text));
}

export function chunkHasCSSignals(chunk: Chunk): boolean {
  return UI_WORKFLOW_PATTERNS.some((p) => p.test(chunk.text));
}

// Extract CS-safe steps from text (filter out any with engineer signals)
export function extractCSSafeSteps(text: string): string[] {
  const lines = text.split("\n");
  const steps: string[] = [];

  const stepIndicators = [
    /^\s*\d+[\).\s]/,           // 1. or 1) style
    /^\s*[-•]\s+/,               // Bullet points
    /^\s*(go\s+to|open|click|navigate|select|toggle|check|view|refresh|retry)/i,
  ];

  const engineerPatterns = [
    ...CLI_PATTERNS,
    ...SCRIPT_PATTERNS,
    ...DATABASE_PATTERNS,
    ...DANGEROUS_PATTERNS,
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 10) continue;

    // Check if this looks like a step
    const isStep = stepIndicators.some((p) => p.test(trimmed));
    if (!isStep) continue;

    // Check if this step contains engineer-only patterns
    const hasEngineerPattern = engineerPatterns.some((p) => p.test(trimmed));
    if (hasEngineerPattern) continue;

    // Check if it looks like a UI action
    const hasUIPattern = UI_WORKFLOW_PATTERNS.some((p) => p.test(trimmed));
    if (hasUIPattern || !hasEngineerPattern) {
      // Clean up the step
      const cleaned = trimmed
        .replace(/^\s*\d+[\).\s]+/, "")
        .replace(/^\s*[-•]\s+/, "")
        .trim();

      if (cleaned.length >= 10 && cleaned.length <= 200) {
        steps.push(cleaned);
      }
    }
  }

  return steps.slice(0, 8); // Max 8 steps
}
