import { z } from "zod";

const price = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u)
  .refine((value) => Number.isFinite(Number(value)) && Number(value) >= 0);
const endpointsSchema = z.object({
  data: z.object({
    endpoints: z
      .array(
        z.object({
          context_length: z.number().int().positive(),
          max_completion_tokens: z.number().int().positive(),
          pricing: z.object({ prompt: price, completion: price }),
        }),
      )
      .min(1),
  }),
});
export interface OpenRouterPriceCeiling {
  prompt: number;
  completion: number;
  reservationUsd: number;
  outputCapacity: number;
  inputCapacity: number;
}

/** Reserve each endpoint's entire advertised context/output capacity, including
 * reasoning. Routing separately prevents prices increasing past this snapshot.
 * Text-only completions request no paid search, images, audio or cache writes.
 */
export const openRouterPriceCeiling = async (
  model: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<OpenRouterPriceCeiling> => {
  const response = await fetcher(
    `https://openrouter.ai/api/v1/models/${model}/endpoints`,
    { signal },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new TypeError("Model endpoint pricing is unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TypeError("Model pricing response is empty");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1048576) {
        await reader.cancel();
        throw new TypeError("Model pricing response is too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = Buffer.concat(chunks, bytes).toString("utf8");
  const endpoints = endpointsSchema.parse(JSON.parse(raw)).data.endpoints;
  // Route ceilings and context bounds use independent maxima so mixing endpoint
  // prices/capacities cannot under-reserve a more expensive large-context route.
  const prompt = Math.max(
    ...endpoints.map((item) => Number(item.pricing.prompt)),
  );
  const completion = Math.max(
    ...endpoints.map((item) => Number(item.pricing.completion)),
  );
  const inputCapacity = Math.max(
    ...endpoints.map((item) => item.context_length),
  );
  const outputCapacity = Math.max(
    ...endpoints.map((item) => item.max_completion_tokens),
  );
  return {
    prompt: prompt * 1000000,
    completion: completion * 1000000,
    outputCapacity,
    inputCapacity,
    reservationUsd:
      Math.ceil(
        (inputCapacity * prompt + (outputCapacity + 16) * completion) *
          1.1 *
          1000000000,
      ) / 1000000000,
  };
};
