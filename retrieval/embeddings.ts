// retrieval/embeddings.ts — OpenAI embeddings for semantic search

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMS = 1536;

/**
 * Embed a single text string using OpenAI's embedding API.
 * @param text - The text to embed
 * @returns A 1536-dimension vector
 * @throws Error if API key is missing or API call fails
 */
export async function embedText(text: string): Promise<number[]> {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  // Handle empty string - return zero vector
  if (!text || text.trim().length === 0) {
    return new Array(EMBEDDING_DIMS).fill(0);
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OpenAI embeddings API error (${response.status}): ${errorText}`
    );
  }

  const data = await response.json();
  const embedding = data?.data?.[0]?.embedding;

  if (!embedding || !Array.isArray(embedding)) {
    throw new Error("Invalid response from OpenAI embeddings API: no embedding returned");
  }

  return embedding;
}

/**
 * Batch embed multiple texts in a single API call.
 * @param texts - Array of texts to embed (max 100)
 * @returns Array of 1536-dimension vectors
 * @throws Error if API key is missing or API call fails
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  if (texts.length === 0) {
    return [];
  }

  if (texts.length > 100) {
    throw new Error("embedBatch supports max 100 texts per call");
  }

  // Handle empty strings by replacing with a placeholder, then replace result with zero vector
  const emptyIndices = new Set<number>();
  const processedTexts = texts.map((t, i) => {
    if (!t || t.trim().length === 0) {
      emptyIndices.add(i);
      return " "; // minimal non-empty text for API
    }
    return t;
  });

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: processedTexts,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OpenAI embeddings API error (${response.status}): ${errorText}`
    );
  }

  const data = await response.json();
  const embeddings = data?.data;

  if (!embeddings || !Array.isArray(embeddings)) {
    throw new Error("Invalid response from OpenAI embeddings API: no embeddings returned");
  }

  // Sort by index since API may return in different order
  embeddings.sort((a: { index: number }, b: { index: number }) => a.index - b.index);

  // Extract vectors and replace empty string results with zero vectors
  return embeddings.map((item: { embedding: number[] }, i: number) => {
    if (emptyIndices.has(i)) {
      return new Array(EMBEDDING_DIMS).fill(0);
    }
    return item.embedding;
  });
}

/**
 * Compute cosine similarity between two vectors.
 * @param a - First vector
 * @param b - Second vector
 * @returns Similarity score between -1 and 1 (1 = identical, 0 = orthogonal)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }

  if (a.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);

  if (denominator === 0) {
    return 0;
  }

  return dotProduct / denominator;
}
