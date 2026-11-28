/**
 * modules/pages/structure/dto/symbols.dto.ts
 * DTOs for workspace-wide LaTeX symbols, citations, commands, packages, and outline responses.
 */

export interface ProjectSymbolLabelDto {
  key: string;
  file: string;
  line: number;
  context?: string;
}

export interface ProjectSymbolCitationDto {
  key: string;
  type: string;
  title?: string;
  author?: string;
  year?: string;
  journal?: string;
  booktitle?: string;
  publisher?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  volume?: string;
  number?: string;
  pages?: string;
  file: string;
  line: number;
  raw?: string;
}

export interface ProjectSymbolCommandDto {
  name: string;
  argCount?: number;
  hasDefault?: boolean;
  defaultValue?: string;
  expansion?: string;
  file: string;
  line: number;
  signature: string;
}

export interface ProjectSymbolEnvironmentDto {
  name: string;
  argCount?: number;
  file: string;
  line: number;
}

export interface ProjectSymbolPackageDto {
  name: string;
  options?: string;
  file: string;
  line: number;
}

export interface ProjectSymbolOutlineDto {
  title: string;
  level: number;
  levelName: string;
  file: string;
  line: number;
  from: number;
  children?: ProjectSymbolOutlineDto[];
}

export interface ProjectSymbolsResponseDto {
  rootDocPath: string | null;
  labels: ProjectSymbolLabelDto[];
  citations: ProjectSymbolCitationDto[];
  customCommands: ProjectSymbolCommandDto[];
  customEnvironments: ProjectSymbolEnvironmentDto[];
  packages: ProjectSymbolPackageDto[];
  bibliographies: string[];
  includedFiles: string[];
  imageFiles: string[];
  files: string[];
  images: string[];
  outline: ProjectSymbolOutlineDto[];
}
