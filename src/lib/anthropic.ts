import Anthropic from '@anthropic-ai/sdk';

export const CHAT_MODEL = 'claude-haiku-4-5';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Uses client.messages.create({ stream: true }) so the HTTP call is made eagerly —
// callers can catch connection/auth errors before committing to a response stream.
export async function chatStream(prompt: string): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();

  const stream = await client.messages.create({
    model: CHAT_MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
  });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          controller.enqueue(encoder.encode(event.delta.text));
        }
      }
      controller.close();
    },
    cancel() {
      stream.controller.abort();
    }
  });
}
