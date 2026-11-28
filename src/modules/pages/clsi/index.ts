/**
 * clsi/index.ts
 * Public entry point for the Pages CLSI (Common LaTeX Service Interface) module.
 */

export { CompilePageDto, ClsiWordCountDto } from './dto/compile.dto';
export { ForwardSyncDto, ReverseSyncDto } from './dto/synctex.dto';
export type {
  AuxFileInfo,
  CompileLogMeta,
  CompileOutcome,
  CompileValidationIssue,
  CompilerDiagnostic,
  DiagnosticsSummary,
  ReverseSyncPoint,
  SyncPoint,
  WordCountFileStats,
  WordCountSection,
  WordCountStats,
} from './domain/ports';
export {
  ClsiService,
  type ClsiCompileResult,
  type EditorLastBuildSummary,
} from './clsi.service';
export { ClsiModule } from './clsi.module';
