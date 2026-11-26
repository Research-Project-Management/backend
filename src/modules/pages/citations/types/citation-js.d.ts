declare module '@citation-js/core' {
  export const plugins: {
    input: {
      chainLink: (input: unknown) => unknown;
      chain: (input: unknown, options?: Record<string, unknown>) => unknown;
    };
  };
}

declare module '@citation-js/plugin-bibtex';
