export type ProjectStateLifecycleGroup =
  | 'conception'
  | 'execution'
  | 'review'
  | 'completed'
  | 'suspended';

export interface DefaultProjectStateTemplate {
  name: string;
  description: string;
  color: string;
  group: ProjectStateLifecycleGroup;
  sequence: number;
  isDefault: boolean;
}

/**
 * 8 Default Research Project States aligned with Academic Lifecycle Standard (CASRAI / ISO 21502).
 * Grouped into 5 macro phases:
 * - conception: Ideation, Planning
 * - execution: Experimentation, Drafting
 * - review: Review
 * - completed: Published
 * - suspended: Paused, Cancelled
 */
export const DEFAULT_PROJECT_STATES: DefaultProjectStateTemplate[] = [
  {
    name: 'Ideation',
    description:
      'Formulating research ideas, preliminary inquiry, hypothesis generation, and literature exploration.',
    color: '#64748b',
    group: 'conception',
    sequence: 0,
    isDefault: true,
  },
  {
    name: 'Planning',
    description:
      'Designing methodology, study proposal, data management planning, and protocol preparation.',
    color: '#0284c7',
    group: 'conception',
    sequence: 1,
    isDefault: false,
  },
  {
    name: 'Experimentation',
    description:
      'Data gathering, laboratory procedures, computational simulations, and empirical testing.',
    color: '#d97706',
    group: 'execution',
    sequence: 2,
    isDefault: false,
  },
  {
    name: 'Drafting',
    description:
      'Authoring scientific manuscript, structuring findings, preparing figures, and synthesizing arguments.',
    color: '#2563eb',
    group: 'execution',
    sequence: 3,
    isDefault: false,
  },
  {
    name: 'Review',
    description:
      'Internal peer critique, defense before examination committee, journal submission, or revision rebuttal.',
    color: '#7c3aed',
    group: 'review',
    sequence: 4,
    isDefault: false,
  },
  {
    name: 'Published',
    description:
      'Research defended, officially accepted/published in journal or conference, and final artifacts archived.',
    color: '#16a34a',
    group: 'completed',
    sequence: 5,
    isDefault: false,
  },
  {
    name: 'Paused',
    description:
      'Temporarily on hold awaiting resources, specimen availability, ethical clearance, or reviewer feedback.',
    color: '#f97316',
    group: 'suspended',
    sequence: 6,
    isDefault: false,
  },
  {
    name: 'Cancelled',
    description:
      'Project permanently discontinued or terminated due to feasibility constraints or policy decisions.',
    color: '#ef4444',
    group: 'suspended',
    sequence: 7,
    isDefault: false,
  },
];
