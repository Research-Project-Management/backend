/**
 * test/unit/manuscripts/clsi/sandbox-config.spec.ts
 * Verifies CLSI sandbox configuration validation, production fail-closed rules,
 * image digest pinning, and legacy environment variable deprecation warnings.
 */

import {
  parseSandboxConfig,
  ClsiSandboxConfig,
} from '../../../../src/modules/manuscripts/clsi/services/sandbox/sandbox-config';
import { SandboxConfigurationException } from '../../../../src/modules/manuscripts/clsi/domain/sandbox-errors';

describe('CLSI Sandbox Configuration & Fail-Closed Rules (Slice S4 / US2 & US5)', () => {
  const validProductionDigest =
    'ghcr.io/sharelatex/clsi@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  describe('Production Environment (Fail-Closed)', () => {
    it('should successfully parse valid production container configuration with digest pinning', () => {
      const config = parseSandboxConfig({
        env: {
          CLSI_SANDBOX_MODE: 'container',
          CLSI_SANDBOX_IMAGE: validProductionDigest,
          NODE_ENV: 'production',
        },
        isProduction: true,
      });

      expect(config.mode).toBe('container');
      expect(config.image).toBe(validProductionDigest);
      expect(config.user).toBe('65534:65534');
      expect(config.memoryMb).toBe(1024);
      expect(config.cpus).toBe(1.0);
      expect(config.isProduction).toBe(true);
    });

    it('should throw SandboxConfigurationException if mode is local-unsafe in production', () => {
      expect(() =>
        parseSandboxConfig({
          env: {
            CLSI_SANDBOX_MODE: 'local-unsafe',
            NODE_ENV: 'production',
          },
          isProduction: true,
        }),
      ).toThrow(SandboxConfigurationException);
    });

    it('should throw SandboxConfigurationException if image is not pinned with @sha256 in production', () => {
      expect(() =>
        parseSandboxConfig({
          env: {
            CLSI_SANDBOX_MODE: 'container',
            CLSI_SANDBOX_IMAGE: 'sharelatex/clsi:latest',
            NODE_ENV: 'production',
          },
          isProduction: true,
        }),
      ).toThrow(SandboxConfigurationException);
    });

    it('should throw SandboxConfigurationException if image is missing in container mode', () => {
      expect(() =>
        parseSandboxConfig({
          env: {
            CLSI_SANDBOX_MODE: 'container',
            NODE_ENV: 'production',
          },
          isProduction: true,
        }),
      ).toThrow(SandboxConfigurationException);
    });

    it('should reject root user in sandbox container config', () => {
      expect(() =>
        parseSandboxConfig({
          env: {
            CLSI_SANDBOX_MODE: 'container',
            CLSI_SANDBOX_IMAGE: validProductionDigest,
            CLSI_SANDBOX_USER: '0:0',
            NODE_ENV: 'production',
          },
          isProduction: true,
        }),
      ).toThrow(SandboxConfigurationException);
    });
  });

  describe('Development & Test Environment', () => {
    it('should allow local-unsafe mode in development', () => {
      const config = parseSandboxConfig({
        env: {
          CLSI_SANDBOX_MODE: 'local-unsafe',
          NODE_ENV: 'development',
        },
        isProduction: false,
      });

      expect(config.mode).toBe('local-unsafe');
      expect(config.isProduction).toBe(false);
    });

    it('should allow tagged images in development container mode', () => {
      const config = parseSandboxConfig({
        env: {
          CLSI_SANDBOX_MODE: 'container',
          CLSI_SANDBOX_IMAGE: 'sharelatex/clsi:v1.2.3',
          NODE_ENV: 'development',
        },
        isProduction: false,
      });

      expect(config.mode).toBe('container');
      expect(config.image).toBe('sharelatex/clsi:v1.2.3');
    });

    it('should provide default image if none specified in development container mode', () => {
      const config = parseSandboxConfig({
        env: {
          CLSI_SANDBOX_MODE: 'container',
          NODE_ENV: 'development',
        },
        isProduction: false,
      });

      expect(config.image).toBe('sharelatex/clsi:latest');
    });
  });

  describe('Legacy Environment Variable Compatibility', () => {
    it('should map USE_DOCKER_SANDBOX=true to container mode', () => {
      const config = parseSandboxConfig({
        env: {
          USE_DOCKER_SANDBOX: 'true',
          DOCKER_IMAGE: 'sharelatex/clsi:test-tag',
          NODE_ENV: 'development',
        },
        isProduction: false,
      });

      expect(config.mode).toBe('container');
      expect(config.image).toBe('sharelatex/clsi:test-tag');
    });

    it('should map USE_DOCKER_SANDBOX=false to local-unsafe in development', () => {
      const config = parseSandboxConfig({
        env: {
          USE_DOCKER_SANDBOX: 'false',
          NODE_ENV: 'development',
        },
        isProduction: false,
      });

      expect(config.mode).toBe('local-unsafe');
    });

    it('should fail closed in production even if legacy USE_DOCKER_SANDBOX=false is passed', () => {
      expect(() =>
        parseSandboxConfig({
          env: {
            USE_DOCKER_SANDBOX: 'false',
            NODE_ENV: 'production',
          },
          isProduction: true,
        }),
      ).toThrow(SandboxConfigurationException);
    });
  });
});
