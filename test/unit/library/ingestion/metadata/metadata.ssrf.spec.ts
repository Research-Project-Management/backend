import { ConflictException } from '@nestjs/common';
import { MetadataRoutingPolicy } from '@/modules/library/ingestion/metadata/metadata.policy';

describe('SSRF Prevention — MetadataRoutingPolicy.validateUrl', () => {
  const blocked = [
    // Loopback
    'http://localhost/',
    'http://localhost:8080/admin',
    'http://127.0.0.1/',
    'http://127.0.0.1:9200/',
    'http://127.255.255.255/',
    // Private class A
    'http://10.0.0.1/',
    'http://10.255.255.255/',
    // Private class B
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    // Private class C
    'http://192.168.0.1/',
    'http://192.168.255.255/',
    // Link-local
    'http://169.254.0.1/',
    'http://169.254.169.254/',
    'http://169.254.169.254/latest/meta-data/',
    // Cloud metadata
    'http://100.100.100.200/',
    // IPv6 loopback
    'http://[::1]/',
    // File scheme
    'file:///etc/passwd',
    // FTP
    'ftp://example.com/',
  ];

  const allowed = [
    'https://api.crossref.org/works/10.1234/foo',
    'https://www.nature.com/articles/s41586-020-2649-2',
    'http://api.semanticscholar.org/graph/v1/paper/DOI:10.1/x',
    'https://openalex.org/works/W12345',
    'https://arxiv.org/abs/1706.03762',
    'https://doi.org/10.1038/s41586-020-2649-2',
  ];

  blocked.forEach((url) => {
    it(`blocks: ${url}`, () => {
      expect(() => MetadataRoutingPolicy.validateUrl(url)).toThrow(ConflictException);
    });
  });

  allowed.forEach((url) => {
    it(`allows: ${url}`, () => {
      expect(() => MetadataRoutingPolicy.validateUrl(url)).not.toThrow();
    });
  });
});
