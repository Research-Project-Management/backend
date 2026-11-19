import { Module } from '@nestjs/common';
import { AI_ENGINE_PORT } from '../ai.constant';
import { EngineService } from './services/engine.service';
import { EngineHttpService } from './services/http.service';
import { EngineStreamService } from './services/stream.service';

@Module({
  providers: [
    EngineHttpService,
    EngineStreamService,
    EngineService,
    {
      provide: AI_ENGINE_PORT,
      useExisting: EngineService,
    },
  ],
  exports: [EngineService, AI_ENGINE_PORT],
})
export class EngineModule {}
