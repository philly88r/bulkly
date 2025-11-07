// scripts/build.js
// Cross-platform safe build script to prepare the static site for Netlify
// Copies only public assets into the build directory.

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  try {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${src} -> ${dest}`);
  } catch (e) {
    // Ignore missing optional files
  }
}

function copyDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  ensureDir(destDir);
  const items = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const item of items) {
    const src = path.join(srcDir, item.name);
    const dest = path.join(destDir, item.name);
    if (item.isDirectory()) {
      copyDir(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

function main() {
  const projectRoot = process.cwd();
  const buildDir = path.join(projectRoot, 'build');

  // Clean build directory
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
  ensureDir(buildDir);

  // Copy root-level static assets
  const rootFiles = fs.readdirSync(projectRoot);
  const includeExtensions = new Set(['.html', '.js', '.css']);
  const excludeFiles = new Set(['.env', '.env.example', 'package.json', 'package-lock.json']);

  for (const name of rootFiles) {
    const srcPath = path.join(projectRoot, name);
    const destPath = path.join(buildDir, name);
    const stat = fs.statSync(srcPath);

    if (stat.isFile()) {
      if (excludeFiles.has(name)) continue;
      if (name === '_redirects') {
        copyFile(srcPath, destPath);
        continue;
      }
      const ext = path.extname(name).toLowerCase();
      if (includeExtensions.has(ext)) {
        copyFile(srcPath, destPath);
      }
    }
  }

  // Copy common asset directories if present
  const dirsToCopy = ['src', 'images', 'assets'];
  for (const dir of dirsToCopy) {
    copyDir(path.join(projectRoot, dir), path.join(buildDir, dir));
  }

  console.log('Build complete. Output in ./build');
}

main();
