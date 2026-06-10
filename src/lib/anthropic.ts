import Anthropic from '@anthropic-ai/sdk';

export const CHAT_MODEL = 'claude-haiku-4-5';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function chatStream(prompt: string): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();

  const stream = client.messages.stream({
    model: CHAT_MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
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
      stream.abort();
    }
  });
}
