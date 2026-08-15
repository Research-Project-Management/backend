import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule } from './core/core.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './modules/identity/auth/auth.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { StorageModule } from './modules/storage/storage.module';
import { LibraryModule } from './modules/library/library.module';
import { ManuscriptModule } from './modules/manuscript/manuscript.module';
import { PlanningModule } from './modules/planning/planning.module';
import { CollaborationModule } from './modules/collaboration/collaboration.module';
import { IntelligenceModule } from './modules/intelligence/intelligence.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
    }),
    CoreModule,
    HealthModule,
    AuthModule,
    OrganizationModule,
    StorageModule,
    LibraryModule,
    ManuscriptModule,
    PlanningModule,
    CollaborationModule,
    IntelligenceModule,
    AnalyticsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
