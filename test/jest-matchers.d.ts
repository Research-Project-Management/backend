export {};

declare global {
  namespace jest {
    interface Matchers<R, _T = unknown> {
      toBeValidUuid(): R;
      toBeValidBibtex(): R;
    }
  }
}
