/**
 * modules/pages/structure/index.ts
 * Public interface for the Pages Virtual Tree & Structure subsystem.
 */

export {
  PageNodeEntity,
  type PageNodeType,
  type PageNodeProps,
  type SerializedTreeNode,
} from './domain/node.entity';
export {
  FileTreeBuilder,
  DEFAULT_MAX_PROJECT_FILES,
  type TreeNode,
} from './domain/tree-builder';
export {
  LatexOutlineExtractor,
  type LatexOutlineLevel,
  type LatexOutlineEntryDto,
} from './domain/latex-outline.extractor';
export {
  StructureError,
  InvalidNodeNameError,
  NodeNotFoundError,
  DuplicateNodePathError,
  CyclicMoveError,
  CannotDeleteRootFolderError,
  MaxProjectFilesExceededError,
} from './domain/structure.errors';
export type { CreateNodeParams } from './domain/structure.ports';
export {
  CreateNodeDto,
  MoveNodeDto,
  RenameNodeDto,
  ReorderNodeDto,
  TreeNodeDto,
} from './dto/node.dto';
export {
  StructureRepository,
  ensurePrismaFolderChain,
} from './structure.repository';
export {
  StructureService,
  type ProjectSymbolLabelDto,
  type ProjectSymbolCitationDto,
  type ProjectSymbolCommandDto,
  type ProjectSymbolEnvironmentDto,
  type ProjectSymbolPackageDto,
  type ProjectSymbolOutlineDto,
  type ProjectSymbolsResponseDto,
} from './structure.service';
export { StructureModule } from './structure.module';
