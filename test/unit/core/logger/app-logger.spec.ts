import { AppLogger } from '@/core/logger/app-logger.service';

describe('AppLogger (Singleton & Chocolate Pattern)', () => {
  let logger: AppLogger;

  beforeEach(() => {
    logger = AppLogger.getInstance('TestContext');
  });

  it('should be a singleton instance', () => {
    const logger2 = AppLogger.getInstance();
    expect(logger).toBe(logger2);
  });

  it('should format log, warn, error, debug, and http without throwing', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});

    logger.log('Informational test message');
    expect(logSpy).toHaveBeenCalled();

    logger.warn('Warning test message');
    expect(warnSpy).toHaveBeenCalled();

    logger.error('Error test message', 'stack trace');
    expect(errorSpy).toHaveBeenCalled();

    logger.debug('Debug test message');
    expect(debugSpy).toHaveBeenCalled();

    logger.http('GET', '/api/test', 200, 45, 'req-123');
    expect(logSpy).toHaveBeenCalled();

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    debugSpy.mockRestore();
  });
});
