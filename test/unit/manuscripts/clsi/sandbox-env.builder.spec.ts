/**
 * test/unit/manuscripts/clsi/sandbox-env.builder.spec.ts
 * Verifies that process environment is strictly filtered against an allow-list,
 * sensitive secrets are purged, and paranoid TeX I/O flags are injected.
 */

import { buildSandboxEnv } from '../../../../src/modules/manuscripts/clsi/domain/sandbox-env.builder';

describe('Sandbox Environment Builder & TeX I/O Hardening (Slice S2 / US3)', () => {
  const mockParentEnv: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TZ: 'UTC',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    TMP: 'C:\\Temp',
    DATABASE_URL: 'postgres://postgres:secret@db:5432/flux',
    JWT_SECRET: 'super-secret-jwt-key-never-leak',
    AWS_SECRET_ACCESS_KEY: 'AKIAIOSFODNN7EXAMPLE',
    REDIS_PASSWORD: 'redis-secret-password',
    PORT: '3000',
    NODE_ENV: 'production',
  };

  it('should filter out all sensitive environment variables from parentEnv', () => {
    const env = buildSandboxEnv({ parentEnv: mockParentEnv, platform: 'linux' });

    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.REDIS_PASSWORD).toBeUndefined();
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.PORT).toBeUndefined();
  });

  it('should preserve standard allow-listed variables (PATH, LANG, LC_ALL, TZ)', () => {
    const env = buildSandboxEnv({ parentEnv: mockParentEnv, platform: 'linux' });

    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.LC_ALL).toBe('en_US.UTF-8');
    expect(env.TZ).toBe('UTC');
  });

  it('should preserve Windows-specific system variables on Windows platform', () => {
    const winEnv = buildSandboxEnv({ parentEnv: mockParentEnv, platform: 'win32' });

    expect(winEnv.SystemRoot).toBe('C:\\Windows');
    expect(winEnv.TEMP).toBe('C:\\Temp');
    expect(winEnv.TMP).toBe('C:\\Temp');
  });

  it('should omit Windows-specific system variables on non-Windows platforms', () => {
    const linuxEnv = buildSandboxEnv({ parentEnv: mockParentEnv, platform: 'linux' });

    expect(linuxEnv.SystemRoot).toBeUndefined();
    expect(linuxEnv.TEMP).toBeUndefined();
    expect(linuxEnv.TMP).toBeUndefined();
  });

  it('should always inject paranoid TeX I/O restrictions (openin_any=p, openout_any=p, shell_escape=f)', () => {
    const env = buildSandboxEnv({ parentEnv: mockParentEnv, isTexProcess: true });

    expect(env.openin_any).toBe('p');
    expect(env.openout_any).toBe('p');
    expect(env.shell_escape).toBe('f');
  });

  it('should override any attempt to tamper with shell_escape or openin_any via extraEnv', () => {
    const env = buildSandboxEnv({
      parentEnv: mockParentEnv,
      extraEnv: {
        shell_escape: 't',
        openin_any: 'a',
        openout_any: 'a',
      },
      isTexProcess: true,
    });

    expect(env.openin_any).toBe('p');
    expect(env.openout_any).toBe('p');
    expect(env.shell_escape).toBe('f');
  });

  it('should accept valid pipeline TeX variables (TEXINPUTS, BIBINPUTS, BSTINPUTS, HOME, TEXMFVAR)', () => {
    const env = buildSandboxEnv({
      parentEnv: mockParentEnv,
      extraEnv: {
        TEXINPUTS: '.:/workspace//:',
        BIBINPUTS: '.:/workspace//:',
        BSTINPUTS: '.:/workspace//:',
        HOME: '/tmp/home',
        TEXMFVAR: '/tmp/texmf-var',
        TEXMFCACHE: '/tmp/texmf-cache',
      },
      isTexProcess: true,
    });

    expect(env.TEXINPUTS).toBe('.:/workspace//:');
    expect(env.BIBINPUTS).toBe('.:/workspace//:');
    expect(env.BSTINPUTS).toBe('.:/workspace//:');
    expect(env.HOME).toBe('/tmp/home');
    expect(env.TEXMFVAR).toBe('/tmp/texmf-var');
    expect(env.TEXMFCACHE).toBe('/tmp/texmf-cache');
  });

  it('should allow extra client variables when listed in clientAllowList (e.g. for docker client)', () => {
    const clientParentEnv = {
      ...mockParentEnv,
      DOCKER_HOST: 'tcp://192.168.1.100:2375',
      DOCKER_CONTEXT: 'remote-docker',
    };

    const env = buildSandboxEnv({
      parentEnv: clientParentEnv,
      clientAllowList: ['DOCKER_HOST', 'DOCKER_CONTEXT'],
      isTexProcess: false,
    });

    expect(env.DOCKER_HOST).toBe('tcp://192.168.1.100:2375');
    expect(env.DOCKER_CONTEXT).toBe('remote-docker');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
  });
});
