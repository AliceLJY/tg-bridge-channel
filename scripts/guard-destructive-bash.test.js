// scripts/guard-destructive-bash.test.js
// guard-destructive-bash.sh 黑名单单测:喂 PreToolUse JSON,断言 exit code。
// exit 2 = 拦截;exit 0 = 放行。设计取向"宁放过不误伤":项目内 rm -rf 子目录必须放行。
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = join(dirname(fileURLToPath(import.meta.url)), "guard-destructive-bash.sh");
const HOME = process.env.HOME || "/root";

function code(command) {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command } });
  return spawnSync("bash", [GUARD], { input, encoding: "utf8" }).status;
}

// —— 应拦截(exit 2)——
const BLOCK = [
  "rm -rf /",
  "rm -rf /*",
  "rm -fr /",
  "rm -rf ~",
  "rm -rf ~/",
  "rm -rf $HOME",
  "rm -rf $HOME/",
  "rm -rf /etc",
  "rm -rf /usr/",
  "rm -fr /var",
  "sudo rm -rf /",
  "rm -rf --no-preserve-root /",
  "rm --recursive --force /etc",
  "echo hi && rm -rf ~",
  `rm -rf ${HOME}`,
  "mkfs.ext4 /dev/sda1",
  "mkfs /dev/sdb",
  "sudo mkfs.xfs /dev/nvme0n1",
  "dd if=/dev/zero of=/dev/sda",
  "dd if=/dev/random of=/dev/disk2 bs=1m",
  "sudo dd if=x.img of=/dev/nvme0n1",
  "echo x > /dev/sda",
  "cat foo > /dev/disk2",
  ":(){ :|:& };:",
  ":() { :|: & };:",
  "shred -uvz /dev/sda",
  "sudo shred /dev/disk2",
];

// —— 应放行(exit 0)——
const ALLOW = [
  "rm -rf node_modules",
  "rm -rf ./build",
  "rm -rf dist",
  "rm -rf /tmp/mytest",
  "rm -rf /tmp/guard-probe",
  `rm -rf ${HOME}/Projects/foo`,
  "rm -rf ~/Projects/old",
  "rm file.txt",
  "rm -r src/legacy",
  "rm -f package-lock.json",
  "npm install",
  "ls -la /",
  "git status",
  "grep -r mkfs .",
  "echo 'mkfs is a tool' > notes.txt",
  "dd if=/dev/zero of=./testfile bs=1M count=10",
  "cat /dev/null > app.log",
  "echo done > /tmp/out.txt",
  "mkdir -p /tmp/foo/bar",
  "find . -name '*.tmp' -delete",
];

for (const c of BLOCK) {
  test(`拦截: ${c}`, () => expect(code(c)).toBe(2));
}
for (const c of ALLOW) {
  test(`放行: ${c}`, () => expect(code(c)).toBe(0));
}

test("抠不到命令 → 放行(不误伤)", () => {
  const r = spawnSync("bash", [GUARD], { input: JSON.stringify({ tool_input: {} }), encoding: "utf8" });
  expect(r.status).toBe(0);
});
