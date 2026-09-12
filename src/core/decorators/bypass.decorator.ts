import { SetMetadata } from '@nestjs/common';

export const BYPASS_ENVELOPE_KEY = 'BYPASS_ENVELOPE_KEY';

/**
 * Decorator to opt-out of standard JSON response enveloping.
 * Use for SSE streaming, raw file downloads, or custom protocol endpoints.
 */
export const BypassEnvelope = () => SetMetadata(BYPASS_ENVELOPE_KEY, true);
