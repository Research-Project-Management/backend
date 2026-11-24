export interface AiHealthStatus {
  status: 'ok' | 'degraded';
  service: string;
  upstream: unknown;
  timestamp: string;
  error?: string;
}

export interface AiGenerateParams {
  prompt: string;
  systemInstruction?: string;
  temperature?: number;
  userId?: string;
  spaceId?: string;
  pageId?: string;
}

export interface AiGenerateResult {
  text: string;
}

export interface AiAuthorizeScopeParams {
  userId?: string;
  spaceId?: string;
  pageId?: string;
}

export interface AiAuthorizedScope {
  spaceId?: string;
  pageId?: string;
}

export interface IAiFacade {
  generate(params: AiGenerateParams): Promise<AiGenerateResult>;
  authorizeScope(params: AiAuthorizeScopeParams): Promise<AiAuthorizedScope>;
}
