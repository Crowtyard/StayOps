// 打包产物图标验证脚本（Node，运行于 desktop/）
// 1) asar 内资源清单与字节一致性（tray.png / tray.ico / app-icon.png / brand-mark.png）
// 2) StayOps.exe 内嵌图标：System.Drawing.Icon.ExtractAssociatedIcon 像素/区域探针
//    （新品牌：深蓝贴片 #0C1832 + 白色建筑）
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const desktopDir = path.resolve(__dirname, "..");

// @electron/asar 是 electron-builder 的传递依赖（pnpm 布局，无顶层 link）
const pnpmDir = path.join(desktopDir, "node_modules", ".pnpm");
const asarPkg = fs
  .readdirSync(pnpmDir)
  .find((d) => d.startsWith("@electron+asar@"));
if (!asarPkg) {
  console.error("FAIL  @electron/asar not found under node_modules/.pnpm");
  process.exit(1);
}
const asar = require(path.join(
  pnpmDir, asarPkg, "node_modules", "@electron", "asar",
));

const unpacked = path.join(desktopDir, "dist", "win-unpacked");
const exe = path.join(unpacked, "StayOps.exe");
const asarFile = path.join(unpacked, "resources", "app.asar");

let failed = false;
function check(name, ok, extra) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);
  if (!ok) failed = true;
}

// ---- 1. exe 与 asar 存在性 ----
check("StayOps.exe exists", fs.existsSync(exe));
check("app.asar exists", fs.existsSync(asarFile));
if (fs.existsSync(exe)) {
  const vi = fs.statSync(exe);
  console.log(`      exe size: ${vi.size} bytes, mtime: ${vi.mtime.toISOString()}`);
}

// ---- 2. asar 内容 ----
if (fs.existsSync(asarFile)) {
  const files = asar.listPackage(asarFile);
  const wanted = [
    "assets/tray.ico",
    "assets/tray.png",
    "assets/app-icon.png",
    "src/startup/index.html",
    "src/startup/brand-mark.png",
    "dist/main.js",
    "package.json",
  ];
  for (const w of wanted) {
    check(`asar contains ${w}`, files.includes("\\" + w.replaceAll("/", "\\")));
  }
  check("asar excludes icon-master.png", !files.some((f) => f.includes("icon-master")));

  const bytesSame = (inAsar, local) => Buffer.compare(inAsar, local) === 0;
  // 注：@electron/asar 的 getNode 只按 path.sep 分段，多层路径需用反斜杠
  const asarPath = (p) => p.replaceAll("/", "\\");
  check(
    "asar tray.ico == assets/tray.ico",
    bytesSame(asar.extractFile(asarFile, asarPath("assets/tray.ico")), fs.readFileSync(path.join(desktopDir, "assets", "tray.ico"))),
  );
  check(
    "asar tray.png == assets/tray.png",
    bytesSame(asar.extractFile(asarFile, asarPath("assets/tray.png")), fs.readFileSync(path.join(desktopDir, "assets", "tray.png"))),
  );
  check(
    "asar app-icon.png == assets/app-icon.png",
    bytesSame(asar.extractFile(asarFile, asarPath("assets/app-icon.png")), fs.readFileSync(path.join(desktopDir, "assets", "app-icon.png"))),
  );
  check(
    "asar brand-mark.png == src/startup/brand-mark.png",
    bytesSame(asar.extractFile(asarFile, asarPath("src/startup/brand-mark.png")), fs.readFileSync(path.join(desktopDir, "src", "startup", "brand-mark.png"))),
  );
  // 启动页 HTML 引用新 PNG 而非内联 SVG
  const html = asar.extractFile(asarFile, asarPath("src/startup/index.html")).toString("utf8");
  check("startup html uses brand-mark.png", html.includes("brand-mark.png"));
  check("startup html has no inline svg brand", !/<svg[\s\S]*brand-mark/.test(html));
}

// ---- 3. exe 内嵌图标探针（System.Drawing）----
// 32px 帧：单像素探针不可靠（建筑特征 ~1px），用区域亮度对比 + 关键点
if (fs.existsSync(exe)) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon("${path.resolve(exe).replace(/\\/g, "\\\\")}")
$bmp = $icon.ToBitmap()
$w = $bmp.Width
function Lum($x, $y) {
  $c = $bmp.GetPixel([int]$x, [int]$y)
  return [double](0.25 * $c.R + 0.6 * $c.G + 0.15 * $c.B)
}
function Alpha($x, $y) { return [int]$bmp.GetPixel([int]$x, [int]$y).A }
# 建筑区域（归一化 x 0.30-0.77, y 0.32-0.69）平均亮度
$bs = 0.0; $bn = 0
for ($yy = [int](0.32 * $w); $yy -lt [int](0.69 * $w); $yy++) {
  for ($xx = [int](0.30 * $w); $xx -lt [int](0.77 * $w); $xx++) {
    if ((Alpha $xx $yy) -gt 100) { $bs += (Lum $xx $yy); $bn++ }
  }
}
# 贴片空白区（左上角建筑外）平均亮度
$ts = 0.0; $tn = 0
for ($yy = [int](0.08 * $w); $yy -lt [int](0.26 * $w); $yy++) {
  for ($xx = [int](0.08 * $w); $xx -lt [int](0.26 * $w); $xx++) {
    if ((Alpha $xx $yy) -gt 100) { $ts += (Lum $xx $yy); $tn++ }
  }
}
$bAvg = if ($bn -gt 0) { $bs / $bn } else { 0 }
$tAvg = if ($tn -gt 0) { $ts / $tn } else { 0 }
Write-Output "SIZE=$w"
Write-Output "BUILDING_AVG=$($bAvg.ToString('F1'))"
Write-Output "TILE_AVG=$($tAvg.ToString('F1'))"
Write-Output "CORNER_ALPHA=$(Alpha 1 1)"
$c = $bmp.GetPixel([int](0.12 * $w), [int](0.5 * $w))
Write-Output "TILE_PX=$($c.R),$($c.G),$($c.B),$($c.A)"
`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
    encoding: "utf8", maxBuffer: 64 * 1024,
  }).trim();
  console.log(out);
  const lines = Object.fromEntries(out.split("\r\n").map((l) => l.split("=")));
  const bAvg = Number(lines["BUILDING_AVG"]);
  const tAvg = Number(lines["TILE_AVG"]);
  const [tr, tg, tb, ta] = (lines["TILE_PX"] || ",,,").split(",").map(Number);
  const isNavy = tb >= tg && tg > tr && tb < 90 && tr < 60;
  check("exe icon: outside tile transparent", Number(lines["CORNER_ALPHA"]) < 30, `alpha=${lines["CORNER_ALPHA"]}`);
  check("exe icon: tile pixel navy", isNavy, lines["TILE_PX"]);
  check(
    "exe icon: building region brighter than tile",
    bAvg > tAvg + 12,
    `building=${bAvg} tile=${tAvg}`,
  );
}

process.exit(failed ? 1 : 0);
