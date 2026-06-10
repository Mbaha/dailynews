const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
export const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text:latest';
export const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || 'gemma4:latest';

export async function embedText(text: string, model = EMBED_MODEL): Promise<number[]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text })
  });
  if (!response.ok) throw new Error(`Ollama embedding failed: ${response.status} ${await response.text()}`);
  const data = await response.json();
  if (!Array.isArray(data.embedding)) throw new Error('Ollama embedding response did not include embedding array');
  return data.embedding;
}

export async function chat(prompt: string, model = CHAT_MODEL): Promise<string> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false })
  });
  if (!response.ok) throw new Error(`Ollama chat failed: ${response.status} ${await response.text()}`);
  const data = await response.json();
  return data.response ?? '';
}

export async function chatStream(prompt: string, model = CHAT_MODEL): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: true })
  });
  if (!response.ok) throw new Error(`Ollama chat failed: ${response.status}`);

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const src = response.body!.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await src.read();
      if (done) { controller.close(); return; }
      // Ollama streams newline-delimited JSON: {"response":"token","done":false}
      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.response) controller.enqueue(encoder.encode(chunk.response));
        } catch {}
      }
    },
    cancel() { src.cancel(); }
  });
}

export function vectorLiteral(vector: number[]) {
  return `[${vector.map((n) => Number(n).toFixed(8)).join(',')}]`;
}
