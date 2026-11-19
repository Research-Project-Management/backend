export const EXPERIMENTS_PORT = Symbol('EXPERIMENTS_PORT');

export const EXPERIMENT_NODE_REPOSITORY = Symbol('EXPERIMENT_NODE_REPOSITORY');
export const EXPERIMENT_VERSION_REPOSITORY = Symbol(
  'EXPERIMENT_VERSION_REPOSITORY',
);

export const EXPERIMENTS_PROCESSING_QUEUE = 'experiments-processing';

export const EXPERIMENTS_JOB_PROCESS_FILE = 'process-file';
export const EXPERIMENTS_JOB_MAINTENANCE_TRASH = 'maintenance-trash-retention';
export const EXPERIMENTS_JOB_MAINTENANCE_MULTIPART =
  'maintenance-multipart-cleanup';
export const EXPERIMENTS_JOB_MAINTENANCE_ORPHAN = 'maintenance-orphan-blob';
