/**
 * realtime/index.ts
 * Public entrypoint for Manuscripts Real-Time Collaboration Gateway.
 */

export * from './realtime.module';
export * from './realtime.service';
export * from './realtime.gateway';
export * from './dto/client-event.dto';
export * from './dto/server-event.dto';

// Domain
export * from './core/domain/entities/presence-session.entity';
export * from './core/domain/entities/doc-room.entity';
export * from './core/domain/value-objects/cursor-position.vo';
export * from './core/domain/value-objects/client-update-payload.vo';
export * from './core/domain/value-objects/user-presence.vo';
export * from './core/domain/exceptions/unauthorized-project.exception';
export * from './core/domain/exceptions/invalid-room.exception';
export * from './core/domain/exceptions/stale-client-rev.exception';

// Ports
export * from './core/ports/room-manager.port';
export * from './core/ports/document-updater-bridge.port';
export * from './core/ports/project-access-verifier.port';
export * from './core/ports/realtime-broadcaster.port';

// Use Cases
export * from './core/use-cases/join-project.use-case';
export * from './core/use-cases/leave-project.use-case';
export * from './core/use-cases/join-doc.use-case';
export * from './core/use-cases/leave-doc.use-case';
export * from './core/use-cases/send-doc-update.use-case';
export * from './core/use-cases/broadcast-cursor.use-case';
export * from './core/use-cases/broadcast-project-event.use-case';
