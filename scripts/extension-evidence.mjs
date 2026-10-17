import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function extensionDigest(directory) {
  const hash = crypto.createHash('sha256');
  async function visit(relative = '') {
    const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Extension evidence cannot include symbolic links');
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) {
        hash.update(name + '\0');
        hash.update(await fs.readFile(path.join(directory, name)));
        hash.update('\0');
      }
    }
  }
  await visit();
  return hash.digest('hex');
}

export async function validateChromeEvidence(file, directory, now = Date.now()) {
  const report = JSON.parse(await fs.readFile(file, 'utf8'));
  if (report.schema !== 1 || report.mode !== 'existing-authenticated-chrome-page'
      || report.candidateDelivery !== 'temporary-page-code' || report.status !== 'passed') {
    throw new Error('Not a passing authenticated Chrome page validation report');
  }
  const age = now - Date.parse(report.verifiedAt);
  if (!Number.isFinite(age) || age < 0 || age > 60 * 60 * 1000) throw new Error('Live validation evidence has expired');
  if (report.extensionDigest !== await extensionDigest(directory)) throw new Error('Extension changed after live validation');
  const required = ['timeline', 'quotedTweets', 'detailMainTweet', 'returnNavigation'];
  if (!required.every(name => report.checks?.some(c => c.name === name && c.passed === true))) {
    throw new Error('Live validation evidence is incomplete');
  }
  if (!(report.samples?.timeline >= 1 && report.samples?.quotes >= 1 && report.samples?.detail >= 1)) {
    throw new Error('Live validation has no positive post samples');
  }
  return report;
}
