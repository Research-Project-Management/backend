import {
  UrlCaptureConnector,
  CapturedPaperMetadata,
} from '../../../src/modules/library/ingestion/url-capture.connector';

describe('UrlCaptureConnector (SSRF & Security)', () => {
  let connector: UrlCaptureConnector;

  beforeEach(() => {
    process.env.URL_CAPTURE_SECRET =
      'deterministic_test_url_capture_secret_key_min_32_bytes_1234567890';
    connector = new UrlCaptureConnector();
  });

  it('rejects loopback and private IPv4 addresses', () => {
    expect(connector.isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    expect(connector.isPrivateOrReservedIp('10.0.0.1')).toBe(true);
    expect(connector.isPrivateOrReservedIp('172.16.0.1')).toBe(true);
    expect(connector.isPrivateOrReservedIp('172.31.255.254')).toBe(true);
    expect(connector.isPrivateOrReservedIp('192.168.1.1')).toBe(true);
    expect(connector.isPrivateOrReservedIp('169.254.169.254')).toBe(true); // AWS/GCP metadata
    expect(connector.isPrivateOrReservedIp('0.0.0.0')).toBe(true);
    expect(connector.isPrivateOrReservedIp('255.255.255.255')).toBe(true);
  });

  it('rejects IPv6 loopback, link-local, ULA, and IPv4-mapped IPv6 addresses', () => {
    expect(connector.isPrivateOrReservedIp('::1')).toBe(true);
    expect(connector.isPrivateOrReservedIp('::')).toBe(true);
    expect(connector.isPrivateOrReservedIp('fe80::1')).toBe(true);
    expect(connector.isPrivateOrReservedIp('fc00::1')).toBe(true);
    expect(connector.isPrivateOrReservedIp('fd12:3456:789a::1')).toBe(true);
    expect(connector.isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    expect(connector.isPrivateOrReservedIp('::ffff:10.0.0.1')).toBe(true);
    expect(connector.isPrivateOrReservedIp('::ffff:169.254.169.254')).toBe(
      true,
    );
  });

  it('allows valid public routable IPv4 and IPv6 addresses', () => {
    expect(connector.isPrivateOrReservedIp('8.8.8.8')).toBe(false);
    expect(connector.isPrivateOrReservedIp('1.1.1.1')).toBe(false);
    expect(connector.isPrivateOrReservedIp('93.184.216.34')).toBe(false); // example.com
    expect(connector.isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
  });

  it('generates cryptographic v1 preview tokens bound to workspace and user', () => {
    const meta: CapturedPaperMetadata = {
      title: 'Attention Is All You Need',
      url: 'https://arxiv.org/abs/1706.03762',
      doi: '10.48550/arXiv.1706.03762',
      year: 2017,
      itemType: 'preprint',
    };

    const context = {
      workspaceId: 'ws-test-123',
      userId: 'usr-456',
    };

    const withToken = connector.attachPreviewToken(meta, context);
    expect(withToken.previewToken).toBeDefined();
    expect(withToken.previewToken?.startsWith('v1.')).toBe(true);

    // Exact matching payload succeeds
    const result = connector.verifyPreviewToken(
      meta,
      withToken.previewToken,
      context,
    );
    expect(result.valid).toBe(true);

    // Tampered title fails verification
    const tampered = { ...meta, title: 'Tampered Title' };
    const tamperedResult = connector.verifyPreviewToken(
      tampered,
      withToken.previewToken,
      context,
    );
    expect(tamperedResult.valid).toBe(false);
    expect(tamperedResult.reason).toBe('signature_mismatch');
  });

  it('rejects expired preview tokens', () => {
    const meta: CapturedPaperMetadata = {
      title: 'Deep Residual Learning for Image Recognition',
      url: 'https://arxiv.org/abs/1512.03385',
      year: 2015,
      itemType: 'preprint',
    };

    // Fabricate an expired token
    const now = Date.now();
    const expiredTimestamp = now - 30 * 60 * 1000; // 30 minutes ago
    const expiredToken = `v1.nonce123.${expiredTimestamp - 1000}.${expiredTimestamp}.abcdef1234567890`;

    const result = connector.verifyPreviewToken(meta, expiredToken);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('token_expired');
  });

  it('rejects malformed preview tokens', () => {
    const meta: CapturedPaperMetadata = {
      title: 'BERT: Pre-training of Deep Bidirectional Transformers',
      url: 'https://arxiv.org/abs/1810.04805',
      year: 2018,
      itemType: 'preprint',
    };

    expect(connector.verifyPreviewToken(meta, undefined).valid).toBe(false);
    expect(connector.verifyPreviewToken(meta, 'invalid-token').valid).toBe(
      false,
    );
    expect(connector.verifyPreviewToken(meta, 'v1.partial.token').valid).toBe(
      false,
    );
  });
});
