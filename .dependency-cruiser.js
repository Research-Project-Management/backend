/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependency detected. Extract shared types/contracts into a lower-level file or module core/ so dependencies flow in one direction.',
      from: { path: '^src/' },
      to: { circular: true },
    },
    {
      name: 'no-cross-module-repository-import',
      severity: 'error',
      comment:
        'Do not import repositories/ from another domain module. Depend on that module public contract/facade instead.',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/.*/repositories/',
        pathNot: '^src/modules/$1/',
      },
    },
    {
      name: 'no-src-importing-test-or-scripts',
      severity: 'error',
      comment:
        'Production code under src/ must never import from test/ or scripts/. Move shared helpers into src/core/.',
      from: { path: '^src/' },
      to: { path: '^(test|scripts)/' },
    },
    {
      name: 'domain-no-prisma',
      severity: 'error',
      comment:
        'Domain files (**/domain/**) must stay persistence-agnostic and must not import @prisma/client. Move Prisma queries into a repository/provider and pass plain data into domain/.',
      from: { path: '^src/.*/domain/' },
      to: { path: 'node_modules/@prisma/client' },
    },
    {
      name: 'domain-no-nestjs',
      severity: 'error',
      comment:
        'Domain files (**/domain/**) must stay framework-free and must not import @nestjs/*. Keep pure business rules in domain/ and wire NestJS DI in services/modules.',
      from: { path: '^src/.*/domain/' },
      to: { path: 'node_modules/@nestjs/' },
    },
  ],
  options: {
    doNotFollow: {
      path: ['node_modules', 'dist', 'coverage'],
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.build.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
