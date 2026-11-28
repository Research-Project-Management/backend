/**
 * modules/pages/page/index.ts
 * Public entry point for the Page aggregate module.
 */

export {
  AssignPageLabelsDto,
  CreatePageFileDto,
  CreateProjectPageDto,
  ImportFileFromProjectDto,
  UpdatePageMetadataDto,
  UpdatePageThumbnailDto,
} from './dto/page.dto';
export type {
  CreatePageFileParams,
  ImportFromProjectParams,
  PageDocRanges,
  UpdatePageContentParams,
  UpdatePageMetadataParams,
} from './types/page.types';
export {
  PageScaffoldService,
  type CreateProjectPageParams,
} from './services/scaffold.service';
export { PageService } from './services/page.service';
export { PageModule } from './page.module';
