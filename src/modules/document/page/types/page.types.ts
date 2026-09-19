export type FormattedPage<
  T extends {
    id: string;
    parentPageId?: string | null;
    mainFileId?: string | null;
  },
> = T & {
  parentPage?: string | null;
  mainFile?: string | null;
};

export type FormattedDocument<
  T extends {
    id: string;
    parentPageId?: string | null;
    mainFileId?: string | null;
  },
> = FormattedPage<T>;
