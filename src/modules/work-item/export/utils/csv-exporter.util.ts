/**
 * RFC 4180 Compliant CSV Serializer with UTF-8 BOM support.
 */

function escapeCsvField(val: unknown): string {
  if (val === null || val === undefined) {
    return '';
  }

  let text: string;
  if (val instanceof Date) {
    text = val.toISOString();
  } else if (typeof val === 'object') {
    text = JSON.stringify(val);
  } else {
    text = String(val);
  }

  // Check if escaping is required: contains comma, quote, or newline
  if (text.includes('"') || text.includes(',') || text.includes('\n') || text.includes('\r')) {
    // RFC 4180: double-quote is escaped with another double-quote
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

export function exportTasksToCsv(tasks: any[]): string {
  const headers = [
    'ID',
    'Identifier',
    'Title',
    'Description',
    'State / Column',
    'Priority',
    'Completed',
    'Assignee Name',
    'Assignee Email',
    'Author Name',
    'Author Email',
    'Start Date',
    'Due Date',
    'Time Spent (Hours)',
    'Labels',
    'Created At',
    'Updated At',
  ];

  const rows: string[] = [];

  // Add RFC 4180 header row
  rows.push(headers.map(escapeCsvField).join(','));

  for (const task of tasks) {
    const labelsStr = Array.isArray(task.labels) ? task.labels.join('; ') : '';

    const row = [
      task.id,
      task.identifier || '',
      task.title || '',
      task.description || task.content || '',
      task.columnId || '',
      task.priority || 'none',
      task.completed ? 'TRUE' : 'FALSE',
      task.assignee?.name || '',
      task.assignee?.email || '',
      task.author?.name || '',
      task.author?.email || '',
      task.startDate ? new Date(task.startDate).toISOString() : '',
      task.dueDate ? new Date(task.dueDate).toISOString() : '',
      task.timeSpent ?? 0,
      labelsStr,
      task.createdAt ? new Date(task.createdAt).toISOString() : '',
      task.updatedAt ? new Date(task.updatedAt).toISOString() : '',
    ];

    rows.push(row.map(escapeCsvField).join(','));
  }

  // Prefix with UTF-8 BOM (\uFEFF) for Excel compatibility
  return '\uFEFF' + rows.join('\r\n');
}
