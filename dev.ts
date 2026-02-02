// dev.ts — Local development server
// Run with: deno task dev

import { dirname, fromFileUrl, join } from "https://deno.land/std@0.224.0/path/mod.ts";

// Get the directory where this script lives
const __dirname = dirname(fromFileUrl(import.meta.url));
const envPath = join(__dirname, ".env");

// Manually load .env file
try {
  const envContent = await Deno.readTextFile(envPath);
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    Deno.env.set(key, value);
  }
  console.log("✓ Loaded .env file");
} catch (e) {
  console.log("⚠ Could not load .env file:", (e as Error).message);
}

// Dynamic import after env is loaded
const { default: handler } = await import("./main.ts");

const port = Number(Deno.env.get("PORT") || 8000);

console.log(`\n🚀 CS Runbook Assistant - Local Dev Server`);
console.log(`   http://localhost:${port}`);
console.log(`\nEndpoints:`);
console.log(`   GET  /              - Status`);
console.log(`   GET  /health        - Health check`);
console.log(`   GET  /rebuild       - Rebuild index from Notion`);
console.log(`   GET  /search?q=...  - Search runbooks`);
console.log(`   GET  /classify?q=...&llm=1 - Classify query (CS vs Engineer)`);
console.log(`\nPress Ctrl+C to stop\n`);

Deno.serve({ port }, handler);
