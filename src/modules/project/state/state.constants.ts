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
    name: 'Proposal & Literature Review',
    description:
      'Drafting research idea, literature review, methodology design, and core objectives.',
    color: '#0284c7',
    sequence: 0,
    isDefault: true,
  },
  {
    name: 'Review & Approval',
    description:
      'Proposal undergoing evaluation by scientific committee, ethics board, or funding agency.',
    color: '#0d9488',
    sequence: 1,
    isDefault: false,
  },
  {
    name: 'Execution & Experimentation',
    description:
      'Team actively gathering data, executing simulations, laboratory experiments, and analyzing results.',
    color: '#d97706',
    sequence: 2,
    isDefault: false,
  },
  {
    name: 'Drafting & Publication',
    description:
      'Core findings established; authoring scientific paper (LaTeX), submitting to peer review, or compiling final report.',
    color: '#3b82f6',
    sequence: 3,
    isDefault: false,
  },
  {
    name: 'Evaluation & Defense',
    description:
      'Independent peer review, evaluation of research findings, and defense before examination committee.',
    color: '#4f46e5',
    sequence: 4,
    isDefault: false,
  },
  {
    name: 'Completed & Archived',
    description:
      'Project successfully defended, final report archived, research data and formal manuscript published.',
    color: '#1a7f37',
    sequence: 5,
    isDefault: false,
  },
  {
    name: 'Suspended',
    description:
      'Project temporarily halted awaiting funding, specimens, equipment repairs, or personnel changes.',
    color: '#f97316',
    sequence: 6,
    isDefault: false,
  },
  {
    name: 'Cancelled',
    description:
      'Project terminated due to infeasibility, policy violation, or strategic re-orientation.',
    color: '#9ca3af',
    sequence: 7,
    isDefault: false,
  },
];
