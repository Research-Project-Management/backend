/**
 * Global Jest Lifecycle & Environment Setup
 * Applied to all test suites via `setupFilesAfterEnv` in package.json.
 */

// 1. Environment Variable Guard (Never hit live cloud/DB accidentally)
process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = process.env.DISABLE_REDIS ?? 'true';
process.env.JWT_SECRET =
  process.env.JWT_SECRET ?? 'flux-test-jwt-secret-key-secure-123456';
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? 'mock-aws-key';
process.env.AWS_SECRET_ACCESS_KEY =
  process.env.AWS_SECRET_ACCESS_KEY ?? 'mock-aws-secret';
process.env.AWS_REGION = process.env.AWS_REGION ?? 'us-east-1';
process.env.S3_BUCKET_NAME = process.env.S3_BUCKET_NAME ?? 'test-bucket';

// 2. Automatically clear all mocks between tests to prevent state leakage
afterEach(() => {
  jest.clearAllMocks();
});

// 3. Suppress noisy NestJS info/debug logs during testing unless DEBUG_TESTS is set
if (!process.env.DEBUG_TESTS) {
  const originalLog = console.log;
  const originalDebug = console.debug;
  const originalInfo = console.info;

  // Filter out [Nest] runtime startup and use-case info logs
  const filterNestNoise =
    (fn: (...args: any[]) => void) =>
    (...args: any[]) => {
      if (
        typeof args[0] === 'string' &&
        (args[0].includes('[Nest]') ||
          args[0].includes('DEBUG') ||
          args[0].includes('LOG'))
      ) {
        return;
      }
      fn(...args);
    };

  console.log = filterNestNoise(originalLog);
  console.debug = filterNestNoise(originalDebug);
  console.info = filterNestNoise(originalInfo);
}

// 4. Custom Domain Matchers
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

expect.extend({
  toBeValidUuid(received: string) {
    const pass = typeof received === 'string' && UUID_REGEX.test(received);
    if (pass) {
      return {
        message: () => `expected ${received} not to be a valid UUID`,
        pass: true,
      };
    } else {
      return {
        message: () =>
          `expected ${received} to be a valid UUID (received ${typeof received}: "${received}")`,
        pass: false,
      };
    }
  },
  toBeValidBibtex(received: string) {
    const pass =
      typeof received === 'string' &&
      received.trim().startsWith('@') &&
      received.includes('{') &&
      received.includes('}');
    if (pass) {
      return {
        message: () => `expected input not to be valid BibTeX`,
        pass: true,
      };
    } else {
      return {
        message: () =>
          `expected input to be valid BibTeX starting with @entry{ (received: "${received}")`,
        pass: false,
      };
    }
  },
});

// 5. Default safe per-test timeout
jest.setTimeout(30000);

export {};
