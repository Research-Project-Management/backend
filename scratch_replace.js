import fs from 'fs';
import path from 'path';

function searchFiles(dir, query, results = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (file === '.git' || file === 'node_modules' || file === '.venv' || file === 'build' || file === '.react-router') continue;
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      searchFiles(fullPath, query, results);
    } else {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (content.includes(query)) {
          results.push({ path: fullPath, length: content.length });
        }
      } catch (err) {
        // ignore
      }
    }
  }
  return results;
}

const allMatches = searchFiles('c:/Users/Dash/Documents/Code/NCKH/Flux/app', 'previewFile');
console.log('Matches for previewFile:');
console.log(allMatches);
