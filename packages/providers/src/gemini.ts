export interface GeminiContentPart {
  text: string;
}

export interface GeminiContentMessage {
  role: 'user' | 'model';
  parts: GeminiContentPart[];
}

export interface GeminiGenerateOptions {
  apiKey: string;
  model?: string;
  systemInstruction?: string;
  contents: Array<{
    role: 'user' | 'model';
    text: string;
  }>;
  temperature?: number;
  maxOutputTokens?: number;
  fetchFn?: typeof fetch;
}

export interface GeminiGenerateResult {
  text: string;
  model: string;
  finishReason?: string;
  promptTokens?: number;
  responseTokens?: number;
  totalTokens?: number;
}

export interface LeadRetentionAnalysisResult {
  leadIntentScore: 'high' | 'medium' | 'low';
  isInterested: boolean;
  pricingQueryDetected: boolean;
  followUpRequired: boolean;
  followUpReason: string | null;
  churnRisk: 'low' | 'medium' | 'high';
  sentiment: 'positive' | 'neutral' | 'negative';
  customerNeeds: string[];
  suggestedAction: string;
  summary: string;
}

export const DEFAULT_GEMINI_MODEL = 'gemini-1.5-flash';

export class GeminiApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(
    statusCode: number,
    code: string,
    message: string
  ) {
    super(`[Gemini API Error] ${code}: ${message}`);
    this.name = 'GeminiApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Generate text using Google Gemini REST API.
 * Uses native fetch compatible with Cloudflare Workers and Node.js.
 */
export async function generateGeminiContent(
  options: GeminiGenerateOptions
): Promise<GeminiGenerateResult> {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    throw new GeminiApiError(400, 'GEMINI_KEY_MISSING', 'Google Gemini API key is missing or empty.');
  }

  const model = (options.model?.trim() || DEFAULT_GEMINI_MODEL).replace(/^models\//, '');
  const fetchFn = options.fetchFn ?? fetch;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  // Convert simple contents array into Gemini API schema
  const geminiContents: GeminiContentMessage[] = options.contents
    .filter((c) => c.text && c.text.trim())
    .map((c) => ({
      role: c.role,
      parts: [{ text: c.text }]
    }));

  if (geminiContents.length === 0) {
    throw new GeminiApiError(400, 'EMPTY_PROMPT', 'No content provided for Gemini generation.');
  }

  const payload: Record<string, unknown> = {
    contents: geminiContents,
    generationConfig: {
      temperature: options.temperature ?? 0.3,
      maxOutputTokens: options.maxOutputTokens ?? 800
    }
  };

  if (options.systemInstruction && options.systemInstruction.trim()) {
    payload.system_instruction = {
      parts: [{ text: options.systemInstruction.trim() }]
    };
  }

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    throw new GeminiApiError(
      502,
      'NETWORK_ERROR',
      `Failed to connect to Google Gemini endpoint: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!response.ok) {
    let errorDetail = '';
    let errorCode = `HTTP_${response.status}`;
    try {
      const errJson = (await response.json()) as {
        error?: { code?: number; message?: string; status?: string };
      };
      if (errJson.error) {
        errorCode = errJson.error.status || errorCode;
        errorDetail = errJson.error.message || '';
      }
    } catch {
      errorDetail = await response.text().catch(() => '');
    }

    if (response.status === 400 && errorDetail.includes('API_KEY_INVALID')) {
      throw new GeminiApiError(401, 'INVALID_API_KEY', 'The provided Google Gemini API key is invalid.');
    }
    if (response.status === 429) {
      throw new GeminiApiError(429, 'QUOTA_EXCEEDED', 'Gemini API quota or rate limit exceeded.');
    }

    throw new GeminiApiError(response.status, errorCode, errorDetail || `Request failed with status ${response.status}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };

  const firstCandidate = data.candidates?.[0];
  const parts = firstCandidate?.content?.parts;
  const generatedText = parts && parts.length > 0 ? parts.map((p) => p.text || '').join('') : '';

  return {
    text: generatedText,
    model,
    finishReason: firstCandidate?.finishReason,
    promptTokens: data.usageMetadata?.promptTokenCount,
    responseTokens: data.usageMetadata?.candidatesTokenCount,
    totalTokens: data.usageMetadata?.totalTokenCount
  };
}

/**
 * Lead Intelligence & Customer Retention Analysis powered by Gemini
 */
export async function analyzeLeadsAndRetentionWithGemini(params: {
  apiKey: string;
  model?: string;
  businessProfile?: unknown;
  customerName?: string | null;
  customerPhone?: string | null;
  messages: Array<{ direction: 'inbound' | 'outbound'; body: string; timestamp?: number }>;
  fetchFn?: typeof fetch;
}): Promise<LeadRetentionAnalysisResult> {
  const formattedMessages = params.messages
    .slice(-25)
    .map((m) => `[${m.direction === 'inbound' ? 'Customer' : 'Business'}]: ${m.body}`)
    .join('\n');

  const profileSummary = params.businessProfile
    ? JSON.stringify(params.businessProfile, null, 2)
    : 'No business profile provided';

  const systemInstruction = `You are an expert SaaS Lead Intelligence and Customer Retention Analyst.
Analyze the provided customer conversation for WhatsApp Booster Pro.
Output STRICTLY valid JSON matching the exact schema below, with NO markdown code fences, NO explanation, and NO trailing text.

JSON Schema:
{
  "leadIntentScore": "high" | "medium" | "low",
  "isInterested": boolean,
  "pricingQueryDetected": boolean,
  "followUpRequired": boolean,
  "followUpReason": string | null,
  "churnRisk": "low" | "medium" | "high",
  "sentiment": "positive" | "neutral" | "negative",
  "customerNeeds": string[],
  "suggestedAction": string,
  "summary": string
}`;

  const prompt = `Business Profile:
${profileSummary}

Customer Details: Name: ${params.customerName || 'Unknown'}, Phone: ${params.customerPhone || 'Unknown'}

Conversation History:
${formattedMessages}

Analyze this customer conversation for lead intent, pricing inquiries, follow-up needs, churn risk, and next best action.`;

  const result = await generateGeminiContent({
    apiKey: params.apiKey,
    model: params.model,
    systemInstruction,
    contents: [{ role: 'user', text: prompt }],
    temperature: 0.1,
    maxOutputTokens: 600,
    fetchFn: params.fetchFn
  });

  const rawJson = result.text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(rawJson) as LeadRetentionAnalysisResult;
    return {
      leadIntentScore: parsed.leadIntentScore || 'low',
      isInterested: Boolean(parsed.isInterested),
      pricingQueryDetected: Boolean(parsed.pricingQueryDetected),
      followUpRequired: Boolean(parsed.followUpRequired),
      followUpReason: parsed.followUpReason || null,
      churnRisk: parsed.churnRisk || 'low',
      sentiment: parsed.sentiment || 'neutral',
      customerNeeds: Array.isArray(parsed.customerNeeds) ? parsed.customerNeeds : [],
      suggestedAction: parsed.suggestedAction || 'Review conversation',
      summary: parsed.summary || 'Customer inquiry reviewed.'
    };
  } catch {
    return {
      leadIntentScore: 'medium',
      isInterested: true,
      pricingQueryDetected: false,
      followUpRequired: true,
      followUpReason: 'Gemini generated non-JSON analysis',
      churnRisk: 'low',
      sentiment: 'neutral',
      customerNeeds: ['General inquiry'],
      suggestedAction: 'Manual review suggested',
      summary: result.text.slice(0, 200)
    };
  }
}
