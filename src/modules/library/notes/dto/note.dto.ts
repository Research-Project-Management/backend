export class CreateNoteDto {
  itemId?: string | null;
  title?: string;
  contentJson?: any;
  contentMd?: string;
  tags?: string[];
}

export class UpdateNoteDto {
  title?: string;
  contentJson?: any;
  contentMd?: string;
  tags?: string[];
  expectedVersion?: number;
}
