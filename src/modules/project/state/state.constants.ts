export interface DefaultProjectStateTemplate {
  name: string;
  description: string;
  color: string;
  sequence: number;
  isDefault: boolean;
}

/**
 * 8 Default Research Project States to seed when a new project is created.
 * Users can customize, reorder (drag & drop), add new, or delete any of these.
 * States are purely dynamic data in the database (table project_states).
 */
export const DEFAULT_PROJECT_STATES: DefaultProjectStateTemplate[] = [
  {
    name: 'Ideation',
    description:
      'Formulating research ideas, preliminary inquiry, hypothesis generation, and literature exploration.',
    color: '#64748b',
    sequence: 0,
    isDefault: true,
  },
  {
    name: 'Planning',
    description:
      'Designing methodology, study proposal, data management planning, and protocol preparation.',
    color: '#0284c7',
    sequence: 1,
    isDefault: false,
  },
  {
    name: 'Experimentation',
    description:
      'Data gathering, laboratory procedures, computational simulations, and empirical testing.',
    color: '#d97706',
    sequence: 2,
    isDefault: false,
  },
  {
    name: 'Drafting',
    description:
      'Authoring scientific manuscript, structuring findings, preparing figures, and synthesizing arguments.',
    color: '#2563eb',
    sequence: 3,
    isDefault: false,
  },
  {
    name: 'Review',
    description:
      'Internal peer critique, defense before examination committee, journal submission, or revision rebuttal.',
    color: '#7c3aed',
    sequence: 4,
    isDefault: false,
  },
  {
    name: 'Published',
    description:
      'Research defended, officially accepted/published in journal or conference, and final artifacts archived.',
    color: '#16a34a',
    sequence: 5,
    isDefault: false,
  },
  {
    name: 'Paused',
    description:
      'Temporarily on hold awaiting resources, specimen availability, ethical clearance, or reviewer feedback.',
    color: '#f97316',
    sequence: 6,
    isDefault: false,
  },
  {
    name: 'Cancelled',
    description:
      'Project permanently discontinued or terminated due to feasibility constraints or policy decisions.',
    color: '#ef4444',
    sequence: 7,
    isDefault: false,
  },
];
