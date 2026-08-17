// ─────────────────────────────────────────────────────────────────────────────
// OpenAI adapter — also serves Azure OpenAI, which is the same wire protocol
// behind a different host and auth scheme.
//
// Structured output uses response_format: { type: 'json_schema', strict: true },
// which is enforced by constrained decoding server-side rather than by asking
// nicely in the prompt. That gives the same guarantee as Anthropic's forced tool
// call, so the feature modules cannot tell the difference.
//
// Strict mode is fussy about the schema itself: every object needs
// additionalProperties:false and a complete `required` list. toOpenAiSchema()
// handles that conversion — see schema.ts for why it is safe.
//
// The `openai` package is an OPTIONAL dependency. If it is not installed this
// provider reports unavailable with an install hint instead of crashing the app,
// so an Anthropic-only deployment carries no extra weight.
// ─────────────────────────────────────────────────────────────────────────────
import {
  type Provider, type Platform, type CompletionRequest, type CompletionResponse,
  type ProviderStatus, RetryableProviderError, SchemaViolationError,
  ProviderUnavailableError, isRetryable,
} from './types.js';
import { toOpenAiSchema } from './schema.js';
import { importOptional, errMsg } from './anthropic.js';

export class OpenAiProvider implements Provider {
  readonly platform: Platform;
  private client: unknown = null;
  private clientKey = '';

  constructor(platform: Extract<Platform, 'openai' | 'azure-openai'> = 'openai') {
    this.platform = platform;
  }

  private get isAzure() { return this.platform === 'azure-openai'; }

  status(): ProviderStatus {
    if (this.isAzure) {
      if (!process.env.AZURE_OPENAI_API_KEY) return { platform: this.platform, available: false, reason: 'AZURE_OPENAI_API_KEY is not set' };
      if (!process.env.AZURE_OPENAI_ENDPOINT) return { platform: this.platform, available: false, reason: 'AZURE_OPENAI_ENDPOINT is not set (e.g. https://<resource>.openai.azure.com)' };
      return { platform: this.platform, available: true };
    }
    return process.env.OPENAI_API_KEY
      ? { platform: this.platform, available: true }
      : { platform: this.platform, available: false, reason: 'OPENAI_API_KEY is not set' };
  }

  private async getClient(): Promise<OpenAiLike> {
    const cacheKey = `${this.platform}|${process.env.OPENAI_API_KEY ?? ''}|${process.env.AZURE_OPENAI_API_KEY ?? ''}|${process.env.AZURE_OPENAI_ENDPOINT ?? ''}`;
    if (this.client && this.clientKey === cacheKey) return this.client as OpenAiLike;

    const mod = await importOptional('openai', this.platform, 'npm i openai');
    const OpenAI = (mod as { default?: new (o: unknown) => OpenAiLike; OpenAI?: new (o: unknown) => OpenAiLike }).default
      ?? (mod as { OpenAI: new (o: unknown) => OpenAiLike }).OpenAI;

    if (this.isAzure) {
      const version = process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21';
      const endpoint = (process.env.AZURE_OPENAI_ENDPOINT ?? '').replace(/\/+$/, '');
      const deployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? '';
      this.client = new OpenAI({
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        // Azure addresses a *deployment*, not a model, and carries the api-version
        // as a query parameter. The deployment name is what goes in `model` below.
        baseURL: `${endpoint}/openai/deployments/${deployment}`,
        defaultQuery: { 'api-version': version },
        defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY },
        maxRetries: 2,
      });
    } else {
      this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 2 });
    }
    this.clientKey = cacheKey;
    return this.client as OpenAiLike;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const st = this.status();
    if (!st.available) throw new ProviderUnavailableError(st.reason ?? 'unavailable', this.platform);

    try {
      const client = await this.getClient();
      // On Azure the deployment name replaces the model id in the path, so `model`
      // is ignored there; sending it anyway is harmless and keeps logs readable.
      const model = this.isAzure ? (process.env.AZURE_OPENAI_DEPLOYMENT ?? req.model) : req.model;

      const res = await client.chat.completions.create({
        model,
        max_completion_tokens: req.maxTokens,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'submit_result', strict: true, schema: toOpenAiSchema(req.schema) },
        },
      });

      const choice = res.choices?.[0];
      if (choice?.finish_reason === 'length') {
        throw new SchemaViolationError('response hit the token ceiling before the object closed — raise ai.maxTokens', this.platform);
      }
      const text = choice?.message?.content;
      if (!text) throw new SchemaViolationError('model returned an empty response', this.platform);

      let value: unknown;
      try { value = JSON.parse(text); }
      catch { throw new SchemaViolationError('model returned content that is not valid JSON', this.platform); }

      return {
        value,
        model: res.model ?? model,
        platform: this.platform,
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      };
    } catch (e) {
      if (e instanceof SchemaViolationError || e instanceof ProviderUnavailableError) throw e;
      if (isRetryable(e)) throw new RetryableProviderError(errMsg(e), this.platform, e);
      throw e;
    }
  }
}

interface OpenAiLike {
  chat: {
    completions: {
      create: (body: unknown) => Promise<{
        choices?: { message?: { content?: string | null }; finish_reason?: string }[];
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>;
    };
  };
}
