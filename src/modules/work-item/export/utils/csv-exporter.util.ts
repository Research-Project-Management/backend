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
    text = String(val as string | number | boolean | bigint);
  }

  // Check if escaping is required: contains comma, quote, or newline
  if (
    text.includes('"') ||
    text.includes(',') ||
    text.includes('\n') ||
    text.includes('\r')
  ) {
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

  for (const workItem of tasks) {
    const labelsStr = Array.isArray(workItem.labels) ? workItem.labels.join('; ') : '';

    const row = [
      workItem.id,
      workItem.identifier || '',
      workItem.title || '',
      workItem.description || workItem.content || '',
      workItem.columnId || '',
      workItem.priority || 'none',
      workItem.completed ? 'TRUE' : 'FALSE',
      workItem.assignee?.name || '',
      workItem.assignee?.email || '',
      workItem.author?.name || '',
      workItem.author?.email || '',
      workItem.startDate ? new Date(workItem.startDate).toISOString() : '',
      workItem.dueDate ? new Date(workItem.dueDate).toISOString() : '',
      workItem.timeSpent ?? 0,
      labelsStr,
      workItem.createdAt ? new Date(workItem.createdAt).toISOString() : '',
      workItem.updatedAt ? new Date(workItem.updatedAt).toISOString() : '',
    ];

    rows.push(row.map(escapeCsvField).join(','));
  }

  // Prefix with UTF-8 BOM (\uFEFF) for Excel compatibility
  return '\uFEFF' + rows.join('\r\n');
}
