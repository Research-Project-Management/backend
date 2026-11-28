/**
 * spelling/index.ts
 * Public entry point for the Pages Spelling & Project Dictionary module.
 */

export {
  CheckSpellingDto,
  CustomDictionaryResponseDto,
  LearnWordDto,
  MisspelledWordDto,
  SpellingReportDto,
} from './dto/spelling.dto';
export type {
  CheckSpellingInput,
  CustomDictionaryResult,
  MisspelledWord,
  SpellingLanguage,
  SpellingReport,
  SupportedLanguage,
} from './types/spelling.types';
export { SpellingService } from './spelling.service';
export { SpellingModule } from './spelling.module';
