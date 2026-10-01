export * from './extraction.module';
export * from './extraction.facade';
export * from './attachments.controller';
export * from './annotations.controller';
export * from './dto/attachments.dto';
export * from './dto/annotations.dto';

// Public Services
export * from './core/services/attachments.service';
export * from './core/services/annotations.service';

// Public Providers & Adapters
export * from './core/adapters/pdf.provider';
export * from './core/adapters/ocr.provider';
export * from './core/adapters/web-snapshot.service';
