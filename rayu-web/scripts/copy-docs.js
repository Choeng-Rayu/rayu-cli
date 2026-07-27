const fs = require('fs');
const path = require('path');

// Docs live at the REPO ROOT (documentations/), not under rayu/. The old path
// pointed at a directory that does not exist, and the existsSync guard below made
// that a silent no-op — so the site served whatever copy happened to be committed
// in public/docs, frozen. Any doc edit was invisible on /docs until this was fixed.
const srcDocsDir = path.join(__dirname, '../../documentations');
const srcChangelog = path.join(__dirname, '../../rayu/CHANGELOG.md');
const destDocsDir = path.join(__dirname, '../public/docs');

// Create destDocsDir if it doesn't exist
if (!fs.existsSync(destDocsDir)) {
  fs.mkdirSync(destDocsDir, { recursive: true });
}

// Copy documentation markdown files
if (fs.existsSync(srcDocsDir)) {
  const files = fs.readdirSync(srcDocsDir);
  let count = 0;
  files.forEach(file => {
    if (file.endsWith('.md')) {
      const srcFile = path.join(srcDocsDir, file);
      const destFile = path.join(destDocsDir, file);
      fs.copyFileSync(srcFile, destFile);
      count++;
    }
  });
  console.log(`Copied ${count} markdown files to public/docs`);
} else {
  console.error(`Source documentation folder not found at ${srcDocsDir}`);
}

// Copy CHANGELOG.md
if (fs.existsSync(srcChangelog)) {
  const destChangelog = path.join(destDocsDir, 'CHANGELOG.md');
  fs.copyFileSync(srcChangelog, destChangelog);
  console.log('Copied CHANGELOG.md to public/docs');
} else {
  console.error(`Source CHANGELOG.md not found at ${srcChangelog}`);
}

console.log('Docs copy task complete.');
