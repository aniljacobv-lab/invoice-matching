// ─────────────────────────────────────────────────────────────────────────────
// Anthropic adapter — serves three platforms from one implementation.
//
//   anthropic  api.anthropic.com, ANTHROPIC_API_KEY
//   bedrock    Claude via AWS Bedrock, standard AWS credential chain
//   vertex     Claude via Google Cloud Vertex AI, ADC credentials
//
// Bedrock and Vertex matter for enterprise deployment: they keep inference inside
// an existing AWS or GCP tenancy, so data residency and procurement go through
// contracts the customer already has. Anthropic publishes @anthropic-ai/bedrock-sdk
// and @anthropic-ai/vertex-sdk with the same messages.create shape as the core SDK,
// so all three share the code below — only the constructor differs.
//
// Structured output is a forced tool call, which the API enforces server-side.
// ─────────────────────────────────────────────────────────────────────────────
import Anthropic from '@anthropic-ai/sdk';
import {
  type Provider, type Platform, type CompletionRequest, type CompletionResponse,
  type ProviderStatus, RetryableProviderError, SchemaViolationError,
  ProviderUnavailableError, isRetryable,
} from './types.js';
import { toAnthropicSchema } from './schema.js';

const TOOL_NAME = 'submit_result';

export interface AnthropicProviderOpts {
  platform: Extract<Platform, 'anthropic' | 'bedrock' | 'vertex'>;
  /** Vertex only. */
  region?: string;
  projectId?: string;
}

export class AnthropicProvider implements Provider {
  readonly platform: Platform;
  private client: unknown = null;
  private clientKey = '';

  constructor(private opts: AnthropicProviderOpts) {
    this.platform = opts.platform;
  }

  status(): ProviderStatus {
    if (this.platform === 'anthropic') {
      return process.env.ANTHROPIC_API_KEY
        ? { platform: this.platform, available: true }
        : { platform: this.platform, available: false, reason: 'ANTHROPIC_API_KEY is not set' };
    }
    if (this.platform === 'bedrock') {
      const hasCreds = !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_ROLE_ARN
        || process.env.AWS_WEB_IDENTITY_TOKEN_FILE || process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI);
      if (!hasCreds) return { platform: this.platform, available: false, reason: 'No AWS credentials found (AWS_ACCESS_KEY_ID, AWS_PROFILE, or an instance role)' };
      if (!process.env.AWS_REGION) return { platform: this.platform, available: false, reason: 'AWS_REGION is not set' };
      return { platform: this.platform, available: true };
    }
    // vertex
    const project = this.opts.projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.ANTHROPIC_VERTEX_PROJECT_ID;
    if (!project) return { platform: this.platform, available: false, reason: 'GOOGLE_CLOUD_PROJECT is not set' };
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.GCE_METADATA_HOST) {
      return { platform: this.platform, available: false, reason: 'No Google credentials — set GOOGLE_APPLICATION_CREDENTIALS or run on GCP with a service account' };
    }
    return { platform: this.platform, available: true };
  }

  /**
   * Build the client lazily. Bedrock and Vertex SDKs are optional dependencies —
   * a deployment that only uses the direct API should not have to install AWS or
   * Google packages, and the Docker image stays smaller for it.
   */
  private async getClient(): Promise<{ messages: { create: (b: unknown) => Promise<AnthropicLikeResponse> } }> {
    const cacheKey = `${this.platform}|${process.env.ANTHROPIC_API_KEY ?? ''}|${process.env.AWS_REGION ?? ''}`;
    if (this.client && this.clientKey === cacheKey) return this.client as never;

    if (this.platform === 'anthropic') {
      this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '', maxRetries: 2 });
    } else if (this.platform === 'bedrock') {
      const mod = await importOptional('@anthropic-ai/bedrock-sdk', this.platform,
        'npm i @anthropic-ai/bedrock-sdk');
      const Ctor = (mod as { AnthropicBedrock: new (o: unknown) => unknown }).AnthropicBedrock;
      this.client = new Ctor({ awsRegion: process.env.AWS_REGION, maxRetries: 2 });
    } else {
      const mod = await importOptional('@anthropic-ai/vertex-sdk', this.platform,
        'npm i @anthropic-ai/vertex-sdk');
      const Ctor = (mod as { AnthropicVertex: new (o: unknown) => unknown }).AnthropicVertex;
      this.client = new Ctor({
        region: this.opts.region ?? process.env.CLOUD_ML_REGION ?? 'us-east5',
        projectId: this.opts.projectId ?? process.env.GOOGLE_CLOUD_PROJECT,
        maxRetries: 2,
      });
    }
    this.clientKey = cacheKey;
    return this.client as never;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const st = this.status();
    if (!st.available) throw new ProviderUnavailableError(st.reason ?? 'unavailable', this.platform);

    try {
      const client = await this.getClient();
      const res = await client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        tools: [{ name: TOOL_NAME, description: 'Return the structured result.', input_schema: toAnthropicSchema(req.schema) }],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: [{ role: 'user', content: req.user }],
      });

      const block = res.content?.find((c) => c.type === 'tool_use');
      if (!block || block.type !== 'tool_use') {
        throw new SchemaViolationError('model returned no tool_use block', this.platform);
      }
      return {
        value: block.input,
        model: res.model ?? req.model,
        platform: this.platform,
        inputTokens: res.usage?.input_tokens ?? 0,
        outputTokens: res.usage?.output_tokens ?? 0,
      };
    } catch (e) {
      if (e instanceof SchemaViolationError || e instanceof ProviderUnavailableError) throw e;
      if (isRetryable(e)) throw new RetryableProviderError(errMsg(e), this.platform, e);
      throw e;
    }
  }
}

interface AnthropicLikeResponse {
  content?: { type: string; input?: unknown }[];
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export async function importOptional(pkg: string, platform: Platform, hint: string): Promise<unknown> {
  try {
    return await import(/* @vite-ignore */ pkg);
  } catch {
    throw new ProviderUnavailableError(`${pkg} is not installed — run: ${hint}`, platform);
  }
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
