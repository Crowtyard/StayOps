// StayOps Desktop 品牌图标生成器（基于用户提供的母版 icon-master.png）
//
// 运行（cwd = desktop/，需 Electron 二进制做高质量缩放）：
//   node_modules\electron\dist\electron.exe scripts\make-brand-icons.cjs assets\icon-master.png
//
// 输出：
//   build/icon.ico            应用图标（16/20/24/32/48/64/128/256，忠实缩放）
//   assets/app-icon.png       窗口图标用 256px PNG
//   assets/tray.ico           托盘图标（16/20/24/32/48，简化版）
//   assets/tray.png           托盘 32px PNG（简化版，运行时加载）
//   src/startup/brand-mark.png 启动页品牌标记 256px PNG
//
// 托盘简化策略：小尺寸下把「深蓝底 + 白色建筑」二值增强——低于贴片色→深蓝，
// 高于→白色（带 gamma 提升），保证 16/20/24px 下建筑轮廓清晰；应用图标帧保持
// 母版忠实缩放。所有输出带几何自检探针，断言失败退出非 0 阻断打包。
"use strict";

const { app, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, ".."); // desktop/
const MASTER = path.resolve(process.argv[2] || "assets/icon-master.png");

const APP_SIZES = [16, 20, 24, 32, 48, 64, 128, 256];
const TRAY_SIZES = [16, 20, 24, 32, 48];
const NAVY = [12, 24, 50]; // 贴片深蓝（母版实测）

// 建筑几何（母版 1254 坐标归一化，实测）
const B = { x0: 0.370, x1: 0.887, y0: 0.386, y1: 0.833 };

// ---------------------------------------------------------------------------

function resizeIter(img, w, h) {
  // 迭代减半 + 末步 best：避免单步大比例缩放混叠
  let cur = img;
  let cw = img.getSize().width;
  let ch = img.getSize().height;
  while (cw > w * 2 && ch > h * 2) {
    cw = Math.max(w, Math.round(cw / 2));
    ch = Math.max(h, Math.round(ch / 2));
    cur = cur.resize({ width: cw, height: ch, quality: "best" });
  }
  return cur.resize({ width: w, height: h, quality: "best" });
}

function lumOf(r, g, b) {
  return 0.25 * r + 0.6 * g + 0.15 * b;
}

/** 托盘简化：贴片保持深蓝，建筑细节按亮度 gamma 提升为白色系。 */
function simplify(img, size) {
  const src = resizeIter(img, size, size);
  const bmp = src.toBitmap(); // BGRA
  const out = Buffer.alloc(bmp.length);
  for (let i = 0; i < bmp.length; i += 4) {
    const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2], a = bmp[i + 3];
    out[i + 3] = a;
    if (a === 0) continue;
    let t = Math.min(1, Math.max(0, (lumOf(r, g, b) - 25) / 230));
    t = Math.pow(t, 0.7); // 提升低亮度建筑像素，压住贴片底色
    out[i] = Math.round(NAVY[2] + (255 - NAVY[2]) * t);
    out[i + 1] = Math.round(NAVY[1] + (255 - NAVY[1]) * t);
    out[i + 2] = Math.round(NAVY[0] + (255 - NAVY[0]) * t);
  }
  return nativeImage.createFromBitmap(out, {
    width: size,
    height: size,
    scaleFactor: 1,
  });
}

// ---------------------------------------------------------------------------

function encodePngBytes(img) {
  const png = img.toPNG();
  if (!png || png.length === 0) throw new Error("toPNG returned empty");
  return png;
}

function writeIco(pngBySize, sizes, file) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const chunks = [];
  for (const s of sizes) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(s === 256 ? 0 : s, 0);
    entry.writeUInt8(s === 256 ? 0 : s, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(pngBySize[s].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += pngBySize[s].length;
    chunks.push(entry);
  }
  fs.writeFileSync(file, Buffer.concat([header, ...chunks, ...sizes.map((s) => pngBySize[s])]));
  console.log(`[make-brand-icons] ${path.basename(file)}: ${sizes.join(",")} -> ${fs.statSync(file).size} bytes`);
}

// ---------------------------------------------------------------------------
// 自检探针
// ---------------------------------------------------------------------------

function probePng(pngBuf, size, label) {
  // 用 nativeImage 载入 PNG 探针
  const img = nativeImage.createFromBuffer(pngBuf);
  const bmp = img.toBitmap();
  const w = img.getSize().width;
  const get = (u, v) => {
    const o = (Math.round(v * w) * w + Math.round(u * w)) * 4;
    return [bmp[o + 2], bmp[o + 1], bmp[o], bmp[o + 3]];
  };
  const isWhite = (u, v) => {
    const [r, g, b, a] = get(u, v);
    return a > 200 && r > 200 && g > 200 && b > 200;
  };
  const isNavy = (u, v) => {
    const [r, g, b, a] = get(u, v);
    return a > 200 && b >= g && g > r && b < 90 && r < 60;
  };
  const isTrans = (u, v) => get(u, v)[3] < 30;

  let ok = true;
  const check = (name, cond) => {
    if (!cond) ok = false;
    console.log(`[probe ${label}] ${cond ? "OK " : "FAIL"} ${name}`);
  };
  if (size >= 48) {
    check("roof line white @(0.45,0.335)", isWhite(0.45, 0.335));
    check("left wall white @(0.32,0.55)", isWhite(0.32, 0.55));
    check("right wall white @(0.545,0.55)", isWhite(0.545, 0.55));
    check("window band1 white @(0.43,0.414)", isWhite(0.43, 0.414));
    check("window band2 white @(0.43,0.484)", isWhite(0.43, 0.484));
    check("window band3 white @(0.43,0.567)", isWhite(0.43, 0.567));
    check("connect band white @(0.66,0.443)", isWhite(0.66, 0.443));
    check("annex white @(0.68,0.50)", isWhite(0.68, 0.50));
    check("base band white @(0.45,0.655)", isWhite(0.45, 0.655));
    check("inter-window gap navy @(0.43,0.53)", isNavy(0.43, 0.53));
    check("above roof navy @(0.45,0.37)", isNavy(0.45, 0.37));
  }
  check("tile navy @(0.12,0.5)", isNavy(0.12, 0.5));
  check("corner transparent @(0.02,0.02)", isTrans(0.02, 0.02));

  // 建筑区域亮度显著高于贴片空白区（小尺寸健壮性检查）
  let bSum = 0, bN = 0, tSum = 0, tN = 0;
  for (let y = Math.round(B.y0 * w); y < Math.round(B.y1 * w); y += Math.max(1, w >> 5))
    for (let x = Math.round(B.x0 * w); x < Math.round(B.x1 * w); x += Math.max(1, w >> 5)) {
      const o = (y * w + x) * 4;
      if (bmp[o + 3] > 100) {
        bSum += lumOf(bmp[o + 2], bmp[o + 1], bmp[o]);
        bN++;
      }
    }
  for (let y = Math.round(0.10 * w); y < Math.round(0.28 * w); y += Math.max(1, w >> 5))
    for (let x = Math.round(0.10 * w); x < Math.round(0.30 * w); x += Math.max(1, w >> 5)) {
      const o = (y * w + x) * 4;
      if (bmp[o + 3] > 100) {
        tSum += lumOf(bmp[o + 2], bmp[o + 1], bmp[o]);
        tN++;
      }
    }
  const bAvg = bSum / Math.max(1, bN);
  const tAvg = tSum / Math.max(1, tN);
  console.log(`[probe ${label}] building avg lum=${bAvg.toFixed(0)} tile avg lum=${tAvg.toFixed(0)}`);
  check(`building brighter than tile (+${(bAvg - tAvg).toFixed(0)})`, bAvg > tAvg + 12);
  return ok;
}

// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  try {
    const master = nativeImage.createFromPath(MASTER);
    if (master.isEmpty()) throw new Error(`cannot load master: ${MASTER}`);
    const s = master.getSize();
    console.log(`[make-brand-icons] master ${s.width}x${s.height}`);

    // ---- 应用图标帧（忠实缩放）----
    const appPng = {};
    for (const size of APP_SIZES) {
      appPng[size] = encodePngBytes(resizeIter(master, size, size));
    }
    writeIco(appPng, APP_SIZES, path.join(ROOT, "build", "icon.ico"));

    // ---- 窗口图标 / 启动页标记 ----
    fs.writeFileSync(path.join(ROOT, "assets", "app-icon.png"), appPng[256]);
    fs.writeFileSync(path.join(ROOT, "src", "startup", "brand-mark.png"), appPng[256]);
    console.log("[make-brand-icons] assets/app-icon.png + src/startup/brand-mark.png (256x256)");

    // ---- 托盘图标（简化版）----
    const trayPng = {};
    for (const size of TRAY_SIZES) {
      trayPng[size] = encodePngBytes(simplify(master, size));
    }
    writeIco(trayPng, TRAY_SIZES, path.join(ROOT, "assets", "tray.ico"));
    fs.writeFileSync(path.join(ROOT, "assets", "tray.png"), trayPng[32]);
    console.log("[make-brand-icons] assets/tray.png (32x32 simplified)");

    // ---- 自检 ----
    let ok = true;
    ok = probePng(appPng[256], 256, "app256") && ok;
    ok = probePng(trayPng[32], 32, "tray32") && ok;
    ok = probePng(trayPng[16], 16, "tray16") && ok;
    if (!ok) {
      console.error("[make-brand-icons] SELF-CHECK FAILED");
      app.exit(1);
      return;
    }
    console.log("[make-brand-icons] done");
    app.exit(0);
  } catch (err) {
    console.error("[make-brand-icons] ERROR", err);
    app.exit(1);
  }
});
