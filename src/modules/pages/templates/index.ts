/**
 * modules/pages/templates/index.ts
 * Public entry point for the Pages Templates & Gallery module.
 */

export {
  InstantiateTemplateDto,
  PublishTemplateDto,
  QueryTemplatesDto,
  UpdateTemplateDto,
} from './dto/template.dto';
export {
  BUILTIN_TEMPLATES,
  filterBuiltinTemplates,
  findBuiltinTemplate,
} from './domain/catalog.domain';
export {
  InvalidTemplateError,
  TemplateForbiddenError,
  TemplateNotFoundError,
} from './domain/errors';
export {
  TemplateFileVo,
  type BinaryAssetRefInput,
  type TemplateFileView,
} from './domain/file.domain';
export {
  TemplateManifest,
  type PageBatchClonePlan,
  type TemplateDetailView,
  type TemplateManifestProps,
  type TemplateSummaryView,
} from './domain/manifest.domain';
export {
  TEMPLATE_CATEGORIES,
  TEMPLATE_COMPILERS,
  TEMPLATE_SCOPES,
  assertCategory,
  assertCompiler,
  assertScope,
  canManageTemplate,
  canReadTemplate,
  deriveTemplateScope,
  inferMimeType,
  normalizeTags,
  normalizeTemplatePath,
  toTemplateSlug,
  type TemplateCategory,
  type TemplateCompiler,
  type TemplateScope,
} from './domain/policy';
export { GalleryService } from './services/gallery.service';
export { PublishService } from './services/publish.service';
export {
  InstantiateService,
  type InstantiateResult,
} from './services/instantiate.service';
export { TemplatesModule } from './templates.module';
