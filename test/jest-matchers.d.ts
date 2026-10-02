export {};

declare global {
  namespace jest {
    interface Matchers<R, T = {}> {
      toBeValidUuid(): R;
      toBeValidBibtex(): R;
    }
  }
}
