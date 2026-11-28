/**
 * modules/integrations/index.ts
 * Public entry point for third-party Integrations (GitHub, Zotero, Mendeley, ORCID).
 */

export {
  INTEGRATION_PROVIDERS,
  isValidProvider,
  type IntegrationProviderType,
  type RemoteCollectionItem,
} from './providers/integration-provider.interface';
export {
  IntegrationsService,
  type ProviderStatusSummary,
} from './integrations.service';
export { IntegrationsModule } from './integrations.module';
