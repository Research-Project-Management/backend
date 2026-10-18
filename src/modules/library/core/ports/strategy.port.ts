/**
 * Unified strategy handler contract for metadata providers, parsers, and extractors.
 * Adheres to the Strategy & Open/Closed Principle (OCP).
 */
export interface IStrategyHandler<TInput, TResult = unknown> {
  /**
   * Evaluates whether this strategy can handle the given input.
   */
  supports(input: TInput): boolean;

  /**
   * Executes the strategy logic on the input.
   */
  execute(input: TInput): Promise<TResult> | TResult;
}
