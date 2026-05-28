/**
 * Export data to CSV file and trigger download
 */
export function exportToCSV(data: Record<string, any>[], filename: string) {
  if (data.length === 0) return;

  const headers = Object.keys(data[0]);
  const csvRows = [
    headers.join(','),
    ...data.map(row =>
      headers.map(h => {
        const val = row[h] ?? '';
        // Escape quotes and wrap in quotes if contains comma/newline
        const str = String(val).replace(/"/g, '""');
        return str.includes(',') || str.includes('\n') || str.includes('"')
          ? `"${str}"`
          : str;
      }).join(',')
    ),
  ];

  const blob = new Blob(['\uFEFF' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}_${new Date().toISOString().split('T')[0]}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Export data to JSON file
 */
export function exportToJSON(data: any, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}_${new Date().toISOString().split('T')[0]}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
