// Phiên bản mô hình gắn vào mỗi dự đoán, để không chấm lẫn các phiên bản luật / thông số khác nhau:
//   <commit git>[+<băm phần code chưa commit>]|t<băm thông số tuning>
// Phần code tính một lần khi khởi động (đổi code thì phải khởi động lại); phần tuning tính mỗi lần vì tự chỉnh lúc chạy.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tuningHash } from './tuning.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (s, n = 7) => createHash('sha1').update(s).digest('hex').slice(0, n);
let code = null;

/** Commit hiện tại, thêm băm nội dung các thay đổi chưa commit (kể cả file mới trong src/, db/) nếu có. */
export function codeVersion() {
  if (code) return code;
  try {
    const git = (cmd) => execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    const commit = git('rev-parse --short HEAD').trim();
    const untracked = git('ls-files --others --exclude-standard -- src db').split('\n').filter(Boolean).sort();
    const dirty = git('diff HEAD -- src db') + untracked.map((f) => `\n${f}\n${readFileSync(join(ROOT, f), 'utf8')}`).join('');
    code = dirty ? `${commit}+${hash(dirty)}` : commit;
  } catch {
    code = 'unknown';
  }
  return code;
}

/** Phiên bản đầy đủ: code + thông số tuning đang dùng. */
export function modelVersion() {
  return `${codeVersion()}|t${tuningHash()}`;
}
