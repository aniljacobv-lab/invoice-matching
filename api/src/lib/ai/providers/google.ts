// ─────────────────────────────────────────────────────────────────────────────
// Google Gemini adapter, via the @google/genai SDK.
//
// Structured output uses responseMimeType 'application/json' plus responseSchema.
// Gemini's schema dialect is an OpenAPI 3.0 subset rather than JSON Schema — no
// type unions, upper-case type names, nullability as a `nullable` flag — so
// toGeminiSchema() converts before dispatch. See schema.ts.
//
// `@google/genai` is an OPTIONAL dependency; missing it reports unavailable with
// an install hint rather than breaking the app.
// ─────────────────────────────────────────────────────────────────────────────
import {
  type Provider, type Platform, type CompletionRequest, type CompletionResponse,
  type ProviderStatus, RetryableProviderError, SchemaViolationError,
  ProviderUnavailableError, isRetryable,
} from './types.js';
import { toGeminiSchema } from './schema.js';
import { importOptional, errMsg } from './anthropic.js';

const KEY_VARS = ['GOOGLE_API_KEY', 'GEMINI_API_KEY'];

export class GoogleProvider implements Provider {
  readonly platform: Platform = 'google';
  private client: unknown = null;
  private clientKey = '';

  private key(): string {
    for (const v of KEY_VARS) if (process.env[v]) return process.env[v] as string;
    return '';
  }

  status(): ProviderStatus {
    return this.key()
      ? { platform: this.platform, available: true }
      : { platform: this.platform, available: false, reason: 'GOOGLE_API_KEY (or GEMINI_API_KEY) is not set' };
  }

  private async getClient(): Promise<GoogleLike> {
    const k = this.key();
    if (this.client && this.clientKey === k) return this.client as GoogleLike;
    const mod = await importOptional('@google/genai', this.platform, 'npm i @google/genai');
    const Ctor = (mod as { GoogleGenAI: new (o: unknown) => GoogleLike }).GoogleGenAI;
    this.client = new Ctor({ apiKey: k });
    this.clientKey = k;
    return this.client as GoogleLike;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const st = this.status();
    if (!st.available) throw new ProviderUnavailableError(st.reason ?? 'unavailable', this.platform);

    try {
      const client = await this.getClient();
      const res = await client.models.generateContent({
        model: req.model,
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        config: {
          // Gemini takes the system prompt as a separate instruction rather than
          // a message role.
          systemInstruction: req.system,
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(req.schema),
          maxOutputTokens: req.maxTokens,
        },
      });

      const text = typeof res.text === 'string' ? res.text : res.text?.();
      if (!text) throw new SchemaViolationError('model returned an empty response', this.platform);

      let value: unknown;
      try { value = JSON.parse(text); }
      catch { throw new SchemaViolationError('model returned content that is not valid JSON', this.platform); }

      return {
        value,
        model: req.model,
        platform: this.platform,
        inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
      };
    } catch (e) {
      if (e instanceof SchemaViolationError || e instanceof ProviderUnavailableError) throw e;
      if (isRetryable(e)) throw new RetryableProviderError(errMsg(e), this.platform, e);
      throw e;
    }
  }
}

interface GoogleLike {
  models: {
    generateContent: (body: unknown) => Promise<{
      text?: string | (() => string);
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }>;
  };
}
