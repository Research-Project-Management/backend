import { SetMetadata } from '@nestjs/common';

export const NO_PROJECT_CONTEXT_KEY = 'no_project_context';

/**
 * Marks an endpoint as intentionally not requiring a project context (e.g. personal library,
 * stateless utilities like word-count, bibtex parse, public templates).
 * Exempts the route from deny-by-default access checks in ProjectAccessGuard.
 */
export const NoProjectContext = () => SetMetadata(NO_PROJECT_CONTEXT_KEY, true);
