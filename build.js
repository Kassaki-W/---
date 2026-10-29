/**
 * 打包脚本（步骤 9）：生成免安装绿色发布包。
 *
 * 产物 dist/12306购票助手-绿色版/：
 *   node.exe                 官方运行时（自包含，目标机器无需装 Node）
 *   src/ web/ package.json   程序文件
 *   node_modules/            运行依赖（express）
 *   启动购票助手.bat          双击：起服务 + 自动打开浏览器
 *
 * 用法：node build.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, 'dist', '12306购票助手-绿色版');
const NODE_VERSION = process.versions.node;
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`;

function copy(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

console.log('[1/4] 复制程序文件…');
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
for (const item of ['src', 'web', 'node_modules', 'package.json']) {
  copy(path.join(ROOT, item), path.join(DIST, item));
}

console.log(`[2/4] 下载官方 node.exe（v${NODE_VERSION}，约 80MB，仅需一次）…`);
const nodeExe = path.join(DIST, 'node.exe');
if (!fs.existsSync(nodeExe)) {
  execSync(`curl -L --fail --retry 3 -o "${nodeExe}" "${NODE_URL}"`, { stdio: 'inherit' });
}

console.log('[3/4] 生成启动脚本…');
fs.writeFileSync(
  path.join(DIST, '启动购票助手.bat'),
  `@echo off\r
rem 双击启动：本机起服务并自动打开浏览器（数据保存在本目录 data\\ 下）\r
cd /d "%~dp0"\r
start "" node.exe src\\main.js\r
`,
  'utf8'
);

console.log('[4/4] 生成说明文件…');
fs.writeFileSync(
  path.join(DIST, '使用说明.txt'),
  `12306 自动购票助手 · 绿色免安装版
==================================

【启动】双击「启动购票助手.bat」，浏览器会自动打开控制台。
       若浏览器未自动打开，请手动访问 http://127.0.0.1:12306

【首次使用】
1. 「登录 / 会话」页：生成二维码，用 12306 官方 App 扫码确认；
2. 「乘车人」页：添加乘车人（证件号校验位会自动核验），并在 12306 官方
   App 确认实名信息后点击「标记核验」；
3. 「设置」页：填写提前量 Δt（建议先用非热门车次试跑实测在途耗时后填入）；
4. 「任务」页：新建任务（候选车次按优先顺序、开抢时刻自行查证车站起售时间），
   校验通过后点「武装」，到点自动查询并提交。

【手机访问】设置页开启「允许手机访问」并设置口令，重启程序后，
手机浏览器访问 http://电脑局域网IP:12306。仅在可信网络开启。

【重要】
- 支付必须由本人在 12306 官方页面完成，程序只做提醒与跳转；
- 遇到人机校验请在控制台「人工介入」窗口期内手动完成；
- 仅限本人及直系亲属自用，不收费、不对外提供服务；
- 停止使用时请在「设置」页执行「清空全部数据」。

【数据位置】所有数据保存在本目录 data\\ 下，删除该目录即彻底清除。
`,
  'utf8'
);

console.log(`\n完成 ✓ 发布包：${DIST}\n整个文件夹拷贝到任意 Windows 电脑即可使用（无需安装 Node）。`);
