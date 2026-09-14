/* =========================================================
 * ビルドを PNG 画像で出力する
 * ---------------------------------------------------------
 * 画面のスクリーンショットではなく Canvas に直接描くので、
 * 画面サイズやアニメーションに関係なく、毎回同じレイアウトの画像になる。
 * app.js のグローバル(state / wagonById / computeEffects など)を利用する。
 *
 * 画像に入る内容:
 *   ビルド名 / タグ / コメント / 編成(矢印・オーラ・レベル色) / 拡張パーツ
 *   (任意) ワゴンの説明 … ツールチップと同じ内容。tips・対応表は個別にON/OFF
 * ========================================================= */
(() => {
  'use strict';

  const OPTS_KEY = 'u2bv:pngopts';
  // 色は style.css の :root と揃える
  const C = {
    bg:'#171c27', cream:'#f6ecd9', muted:'#9aa3b2', gold:'#ffce4a', green:'#5fd07a',
    teal:'#39c2a8', rail:'#ff7a3d', edge:'#374255', wood:'#7a5a36', purple:'#c79bf2', red:'#ff8a8a',
  };
  const FAM = '"M PLUS Rounded 1c", system-ui, sans-serif';
  const BRAND = '"Baloo 2", "M PLUS Rounded 1c", sans-serif';
  const F = (size, weight = 500, fam = FAM) => `${weight} ${size}px ${fam}`;

  // レイアウト(style.css の列車ビューに合わせた寸法)
  const PAD = 44;
  const CARD_W = 116, CARD_H = 112, CELL_W = 122, ENG_W = 158, COUP_W = 9;
  const MIN_W = 1080;

  const CAT_COLOR = { normal:C.green, special:C.purple, versus:C.red, engine:C.teal };

  /* ---------- 小物 ---------- */
  const imgs = new Map(); // src -> HTMLImageElement | null
  function loadImg(src){
    if (!src) return Promise.resolve(null);
    if (imgs.has(src)) return Promise.resolve(imgs.get(src));
    return new Promise(res => {
      const im = new Image();
      im.onload = () => { imgs.set(src, im); res(im); };
      im.onerror = () => { imgs.set(src, null); res(null); };
      im.src = src;
    });
  }
  const IMG = src => (src && imgs.get(src)) || null;

  function rr(ctx, x, y, w, h, r){
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  // 画像を枠に収めて描く(縦横比維持)。bottom=true なら下揃え
  function drawFit(ctx, im, x, y, w, h, bottom, shadow){
    if (!im) return;
    const s = Math.min(w / im.naturalWidth, h / im.naturalHeight);
    const dw = im.naturalWidth * s, dh = im.naturalHeight * s;
    const dx = x + (w - dw) / 2, dy = bottom ? y + h - dh : y + (h - dh) / 2;
    ctx.save();
    if (shadow) { ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 4; }
    ctx.drawImage(im, dx, dy, dw, dh);
    ctx.restore();
  }
  function text(ctx, s, x, cy, font, color, align = 'left'){
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.fillText(s, x, cy);
  }
  // 日本語向けの折り返し(1文字単位 + 行頭禁則はぶら下げ)
  const NO_START = '、。，．・：；？！ー）」』】〉》〕,.)!?';
  function wrap(ctx, s, maxW){
    const out = [];
    String(s ?? '').split('\n').forEach(para => {
      let line = '';
      for (const ch of Array.from(para)) {
        const t = line + ch;
        if (line && ctx.measureText(t).width > maxW && !NO_START.includes(ch)) { out.push(line); line = ch; }
        else line = t;
      }
      out.push(line);
    });
    return out;
  }
  function ellipsis(ctx, s, maxW){
    s = String(s ?? '');
    if (ctx.measureText(s).width <= maxW) return s;
    const chars = Array.from(s);
    while (chars.length && ctx.measureText(chars.join('') + '…').width > maxW) chars.pop();
    return chars.join('') + '…';
  }
  const fgOn = lv => (lv === 4 || lv >= 6) ? '#fff' : '#1c2230';

  /* ---------- 描画用のデータをまとめる ---------- */
  function buildModel(){
    const fx = computeEffects();
    const n = state.wagons.length;
    const items = [];
    for (let i = 0; i < n; i++) {
      if (state.enginePos === i) items.push({ t:'engine' });
      items.push({ t:'wagon', i });
    }
    if (state.enginePos >= n) items.push({ t:'engine' });

    const wagons = state.wagons.map((w, i) => {
      const def = wagonById[w.id];
      const plus = fx.plus[i];
      const effLv = w.level + plus.total;
      const dispLv = Math.min(effLv, maxLevel(def));
      const seen = {};
      (fx.bands[i] || []).forEach(a => {
        if (!seen[a.type]) seen[a.type] = { type:a.type, src:false };
        if (a.src) seen[a.type].src = true;
      });
      return {
        i, no: n - i, w, def, plus, effLv, dispLv,
        bands: Object.values(seen), icon: wagonIcon(def, dispLv),
        parts: w.ext.filter(Boolean), consume: consumeSpec(w.id),
      };
    });

    // 矢印(レーン割り当ては画面と同じ規則)
    const flows = computeFlows().map(f => ({ ...f, lo: Math.min(f.from, f.to), hi: Math.max(f.from, f.to) }));
    flows.sort((p, q) => p.lo - q.lo || p.hi - q.hi);
    const lanes = [];
    flows.forEach(p => {
      let L = 0;
      for (;; L++) {
        if (!lanes[L]) { lanes[L] = []; break; }
        if (!lanes[L].some(([lo, hi]) => p.lo < hi && lo < p.hi)) break;
      }
      lanes[L].push([p.lo, p.hi]); p.lane = L;
      // 矢印の上に載せる資材アイコン(画面で流れているものと同じ)
      let keys = ['mixed'];
      if (p.part === 'storage-pull' || p.part === 'front-pull') {
        const cs = consumeSpec(state.wagons[p.to] && state.wagons[p.to].id);
        if (cs) keys = cs.keys;
      }
      p.keys = keys.slice(0, 2);
    });

    return {
      name: state.name, concept: state.concept, tags: state.tags,
      eng: engineById[state.engine], engineFront: state.enginePos >= n,
      items, wagons, flows, laneCount: lanes.length,
    };
  }

  async function preload(m){
    const srcs = new Set();
    if (m.eng) srcs.add(m.eng.icon);
    m.wagons.forEach(e => {
      srcs.add(e.icon);
      e.parts.forEach(p => srcs.add(extIcon(p)));
      if (e.consume) e.consume.keys.forEach(k => srcs.add(matIcon(k)));
      if (e.def.expansion_parts) Object.keys(e.def.expansion_parts).forEach(p => srcs.add(extIcon(p)));
    });
    m.flows.forEach(f => f.keys.forEach(k => srcs.add(matIcon(k))));
    await Promise.all([...srcs].map(loadImg));
  }

  // Webフォントは使う文字の分だけ遅延読み込みされるので、描く前に必要な文字を読ませる
  const STATIC_TEXT = 'Unrailed2·BuildViewer無題のビルド編成拡張パーツ装着なしワゴンの説明台先頭消費資材前後に効果受けている実効基本のステータス推進式チャージ変化なしは値データwiki未収録ため収録上限表示していますエンジン性能特性作者メモtips対応表通常特殊対戦初期数水容量開始速度出典0123456789+→⭕×…#.:()（）・/';
  async function loadFonts(m){
    const defs = [...new Set(m.wagons.map(e => e.def))];
    const all = STATIC_TEXT + JSON.stringify({ s: state, d: defs, e: m.eng, n: EXT_NAME, i: EXT_INFO, a: AURA_STYLE, l: MAT_INFO.labels });
    const faces = [F(12, 500), F(12, 600), F(12, 700), F(12, 800)];
    try {
      await Promise.all([...faces.map(f => document.fonts.load(f, all)), document.fonts.load(F(15, 800, BRAND), 'Unrailed2 · Build Viewer')]);
    } catch {}
  }

  /* ---------- ページ全体を描く(戻り値は使った高さ) ---------- */
  function paint(ctx, W, H, m, opts){
    // 背景
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    if (H) {
      const g1 = ctx.createRadialGradient(W * .75, -60, 0, W * .75, -60, 700);
      g1.addColorStop(0, 'rgba(36,48,73,1)'); g1.addColorStop(1, 'rgba(36,48,73,0)');
      ctx.fillStyle = g1; ctx.fillRect(0, 0, W, H);
      const g2 = ctx.createRadialGradient(0, H + 60, 0, 0, H + 60, 600);
      g2.addColorStop(0, 'rgba(42,28,22,1)'); g2.addColorStop(1, 'rgba(42,28,22,0)');
      ctx.fillStyle = g2; ctx.fillRect(0, 0, W, H);
    }

    let y = PAD;
    const innerW = W - PAD * 2;

    // ブランド
    ctx.font = F(15, 800, BRAND);
    let bx = PAD;
    [['Unrailed', C.muted], ['2', C.rail], [' · Build Viewer', C.muted]].forEach(([s, col]) => {
      text(ctx, s, bx, y + 9, F(15, 800, BRAND), col); bx += ctx.measureText(s).width;
    });
    y += 30;

    // ビルド名
    ctx.font = F(30, 800);
    wrap(ctx, m.name || '無題のビルド', innerW).forEach(l => { text(ctx, l, PAD, y + 19, F(30, 800), C.cream); y += 42; });

    // エンジン・台数
    text(ctx, `🚂 ${m.eng ? m.eng.name_ja : ''}　ワゴン ${m.wagons.length}台`, PAD, y + 10, F(13, 700), C.muted);
    y += 26;

    // タグ
    if (m.tags.length) {
      let tx = PAD;
      ctx.font = F(12, 800);
      m.tags.forEach(t => {
        const w = ctx.measureText(t).width + 22;
        if (tx + w > W - PAD && tx > PAD) { tx = PAD; y += 32; }
        rr(ctx, tx, y, w, 24, 12);
        ctx.fillStyle = 'rgba(57,194,168,.1)'; ctx.fill();
        ctx.strokeStyle = 'rgba(57,194,168,.5)'; ctx.lineWidth = 1; ctx.stroke();
        text(ctx, t, tx + w / 2, y + 12, F(12, 800), C.teal, 'center');
        tx += w + 8;
      });
      y += 34;
    }

    // コメント
    if (m.concept) {
      y += 4;
      ctx.font = F(15, 500);
      wrap(ctx, m.concept, innerW).forEach(l => { text(ctx, l, PAD, y + 13, F(15, 500), 'rgba(246,236,217,.9)'); y += 26; });
    }

    // 区切り
    y += 16;
    ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fillRect(PAD, y, innerW, 2);
    y += 20;

    y = paintTrain(ctx, W, y, m);
    y = paintLegend(ctx, W, y, m);
    y = paintPartsList(ctx, W, y, m);
    if (opts.desc) y = paintDescriptions(ctx, W, y, m, opts);

    // フッター
    y += 30;
    text(ctx, 'Unrailed! 2 Build Viewer ・ データ出典: Unrailed2@wiki', W / 2, y + 8, F(11, 600), 'rgba(154,163,178,.7)', 'center');
    y += 16 + PAD - 10;
    return y;
  }

  /* ---------- 編成(列車・矢印) ---------- */
  function trainWidth(m){
    return m.items.reduce((s, it, k) => s + (k ? COUP_W : 0) + (it.t === 'engine' ? ENG_W : CELL_W), 0);
  }

  function paintTrain(ctx, W, y, m){
    const tw = trainWidth(m);
    let x = PAD + Math.max(0, (W - PAD * 2 - tw) / 2);
    const pos = m.items.map((it, k) => {
      if (k) x += COUP_W;
      const w = it.t === 'engine' ? ENG_W : CELL_W;
      const p = { x, w }; x += w; return p;
    });
    const centerOf = {};
    m.items.forEach((it, k) => { if (it.t === 'wagon') centerOf[it.i] = pos[k].x + pos[k].w / 2; });

    // 矢印(コの字)
    if (m.flows.length) {
      const areaH = 18 + (m.laneCount - 1) * 15 + 20;
      const yEnd = y + areaH;
      // 優先度の低い経路を先に、優先の経路を上に重ねる
      [...m.flows].sort((a, b) => (a.priority ? 1 : 0) - (b.priority ? 1 : 0)).forEach(f => {
        const x1 = centerOf[f.from], x2 = centerOf[f.to];
        if (x1 == null || x2 == null) return;
        const apex = yEnd - 18 - f.lane * 15;
        const col = FLOW_PARTS[f.part].color;
        ctx.save();
        ctx.globalAlpha = f.priority ? 1 : .55;
        ctx.strokeStyle = col; ctx.lineWidth = 2.6; ctx.lineJoin = 'miter';
        ctx.setLineDash(f.priority ? [] : [6, 5]);
        ctx.beginPath();
        ctx.moveTo(x1, yEnd - 4); ctx.lineTo(x1, apex); ctx.lineTo(x2, apex); ctx.lineTo(x2, yEnd - 10);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.moveTo(x2 - 5.5, yEnd - 11); ctx.lineTo(x2 + 5.5, yEnd - 11); ctx.lineTo(x2, yEnd - 2); ctx.closePath(); ctx.fill();
        // 流れている資材アイコン
        const ic = f.keys.map(k => IMG(matIcon(k))).filter(Boolean);
        if (ic.length) {
          const bw = ic.length * 17 + 6, mx = (x1 + x2) / 2;
          rr(ctx, mx - bw / 2, apex - 11, bw, 22, 6);
          ctx.fillStyle = 'rgba(23,28,39,.92)'; ctx.fill();
          ic.forEach((im, k) => drawFit(ctx, im, mx - bw / 2 + 3 + k * 17, apex - 9, 17, 17));
        }
        ctx.restore();
      });
      y = yEnd;
    }

    // 車両
    let rowH = 0;
    m.items.forEach((it, k) => {
      const p = pos[k];
      if (k) { ctx.fillStyle = C.wood; rr(ctx, p.x - COUP_W, y + 64, COUP_W, 6, 2); ctx.fill(); }
      const h = it.t === 'engine' ? paintEngine(ctx, p.x, y, m) : paintWagon(ctx, p.x, y, m.wagons[it.i]);
      rowH = Math.max(rowH, h);
    });
    return y + rowH + 14;
  }

  function paintEngine(ctx, x, y, m){
    if (!m.eng) return 0;
    drawFit(ctx, IMG(m.eng.icon), x + (ENG_W - 148) / 2, y, 148, 126, true, true);
    ctx.font = F(11, 700);
    const name = m.eng.name_ja, front = m.engineFront ? ' (先頭)' : '';
    const tw = ctx.measureText(name).width + (front ? ctx.measureText(front).width : 0);
    const sx = x + ENG_W / 2 - tw / 2;
    text(ctx, name, sx, y + 138, F(11, 700), C.muted);
    if (front) text(ctx, front, sx + ctx.measureText(name).width, y + 138, F(11, 700), C.gold);
    return 150;
  }

  function paintWagon(ctx, x, y, e){
    const cx = x + (CELL_W - CARD_W) / 2, cy = y;
    // カード本体
    ctx.save();
    rr(ctx, cx, cy, CARD_W, CARD_H, 14); ctx.clip();
    const lg = ctx.createLinearGradient(0, cy, 0, cy + CARD_H);
    lg.addColorStop(0, 'rgba(255,255,255,.035)'); lg.addColorStop(1, 'rgba(0,0,0,.18)');
    ctx.fillStyle = lg; ctx.fillRect(cx, cy, CARD_W, CARD_H);
    const rg = ctx.createRadialGradient(cx + CARD_W / 2, cy + CARD_H * .7, 0, cx + CARD_W / 2, cy + CARD_H * .7, 70);
    rg.addColorStop(0, 'rgba(255,255,255,.07)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rg; ctx.fillRect(cx, cy, CARD_W, CARD_H);
    // オーラ帯(上) / レベル色(下)
    let by = cy;
    e.bands.forEach(b => {
      const h = b.src ? 7 : 5;
      ctx.globalAlpha = .9; ctx.fillStyle = AURA_STYLE[b.type].color; ctx.fillRect(cx, by, CARD_W, h); by += h;
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = levelColor(e.effLv); ctx.fillRect(cx, cy + CARD_H - 5, CARD_W, 5);
    ctx.restore();
    // オーラ発生源は枠を色付け
    const src = e.bands.find(b => b.src);
    if (src) { rr(ctx, cx + 1, cy + 1, CARD_W - 2, CARD_H - 2, 13); ctx.strokeStyle = AURA_STYLE[src.type].color; ctx.lineWidth = 2; ctx.stroke(); }

    drawFit(ctx, IMG(e.icon), cx + 6, cy + CARD_H - 12 - 82, 104, 82, true, true);
    text(ctx, `#${e.no}`, cx + 8, cy + CARD_H - 16, F(10, 800), 'rgba(154,163,178,.85)');
    if (e.w.memo) text(ctx, '📝', cx + CARD_W - 7, cy + CARD_H - 16, F(11, 500), C.cream, 'right');
    if (e.plus.total > 0) {
      const s = `+${e.plus.total}Lv`;
      ctx.font = F(10, 800);
      const bw = ctx.measureText(s).width + 10;
      rr(ctx, cx + CARD_W - 5 - bw, cy + 22, bw, 16, 6);
      ctx.fillStyle = levelColor(e.effLv); ctx.fill();
      text(ctx, s, cx + CARD_W - 5 - bw / 2, cy + 30, F(10, 800), fgOn(e.effLv), 'center');
    }

    // 名前
    ctx.font = F(11, 700);
    text(ctx, ellipsis(ctx, e.def.name_ja, CARD_W), x + CELL_W / 2, cy + CARD_H + 12, F(11, 700), C.cream, 'center');
    // レベル + 消費資材
    const lvS = 'Lv.' + e.w.level + (e.plus.total > 0 ? `→${e.effLv}` : '');
    ctx.font = F(11, 800);
    const lw = ctx.measureText(lvS).width;
    const icons = e.consume ? e.consume.keys.map(k => IMG(matIcon(k))).filter(Boolean) : [];
    const gw = lw + (icons.length ? 6 + icons.length * 18 : 0);
    let gx = x + CELL_W / 2 - gw / 2;
    text(ctx, lvS, gx, cy + CARD_H + 31, F(11, 800), C.muted);
    gx += lw + 6;
    icons.forEach(im => { drawFit(ctx, im, gx, cy + CARD_H + 23, 16, 16); gx += 18; });

    // 装着中の拡張パーツ(3個ずつ折り返し)
    const SL = 28, GAP = 4;
    let rowsN = 0;
    for (let r = 0; r * 3 < e.parts.length; r++) {
      const row = e.parts.slice(r * 3, r * 3 + 3);
      const rw = row.length * SL + (row.length - 1) * GAP;
      const sy = cy + CARD_H + 44 + r * (SL + GAP);
      row.forEach((pid, k) => {
        const sx = x + CELL_W / 2 - rw / 2 + k * (SL + GAP);
        rr(ctx, sx, sy, SL, SL, 7);
        ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fill();
        ctx.strokeStyle = '#4a5568'; ctx.lineWidth = 1.5; ctx.stroke();
        drawFit(ctx, IMG(extIcon(pid)), sx + 3, sy + 3, SL - 6, SL - 6);
      });
      rowsN++;
    }
    return CARD_H + 44 + (rowsN ? rowsN * (SL + GAP) : 0) + 2;
  }

  /* ---------- 凡例 ---------- */
  function paintLegend(ctx, W, y, m){
    const items = [];
    [...new Set(m.flows.map(f => f.part))].forEach(p => items.push({ color: FLOW_PARTS[p].color, label: EXT_NAME[p] || p, th: 3 }));
    const auras = new Set();
    m.wagons.forEach(e => { if (e.def.aura) auras.add(e.def.aura.type); });
    if (state.engine === 'pusher' && m.wagons.length) auras.add('pusher');
    auras.forEach(a => items.push({ color: AURA_STYLE[a].color, label: AURA_STYLE[a].label + 'の効果範囲', th: 5 }));
    if (!items.length) return y;
    let lx = PAD;
    ctx.font = F(12, 600);
    items.forEach(it => {
      const w = 22 + 7 + ctx.measureText(it.label).width;
      if (lx + w > W - PAD && lx > PAD) { lx = PAD; y += 22; }
      ctx.fillStyle = it.color; ctx.fillRect(lx, y + 10 - it.th / 2, 22, it.th);
      text(ctx, it.label, lx + 29, y + 10, F(12, 600), C.muted);
      lx += w + 20;
    });
    return y + 30;
  }

  /* ---------- セクション見出し ---------- */
  function section(ctx, W, y, label){
    y += 22;
    text(ctx, label, PAD, y + 12, F(18, 800), C.cream);
    y += 30;
    ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(PAD, y, W - PAD * 2, 1);
    ctx.fillStyle = C.gold; ctx.fillRect(PAD, y - 1, 36, 3);
    return y + 14;
  }

  /* ---------- 拡張パーツ一覧 ---------- */
  function paintPartsList(ctx, W, y, m){
    y = section(ctx, W, y, '拡張パーツ');
    const list = [...m.wagons].reverse().filter(e => e.parts.length); // #1(先頭)から
    if (!list.length) {
      text(ctx, '(装着なし)', PAD, y + 10, F(13, 600), C.muted);
      return y + 26;
    }
    const LABEL_W = 200;
    list.forEach(e => {
      ctx.font = F(13, 800);
      text(ctx, ellipsis(ctx, `#${e.no} ${e.def.name_ja}`, LABEL_W - 12), PAD, y + 14, F(13, 800), C.cream);
      let px = PAD + LABEL_W, py = y;
      e.parts.forEach(pid => {
        const name = EXT_NAME[pid] || pid;
        ctx.font = F(12, 700);
        const cw = 8 + 20 + 6 + ctx.measureText(name).width + 10;
        if (px + cw > W - PAD && px > PAD + LABEL_W) { px = PAD + LABEL_W; py += 34; }
        rr(ctx, px, py, cw, 28, 8);
        ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1; ctx.stroke();
        drawFit(ctx, IMG(extIcon(pid)), px + 8, py + 4, 20, 20);
        text(ctx, name, px + 34, py + 14, F(12, 700), C.cream);
        px += cw + 8;
      });
      y = py + 36;
    });
    return y;
  }

  /* ---------- ワゴンの説明(ツールチップと同じ内容) ---------- */
  function paintDescriptions(ctx, W, y, m, opts){
    y = section(ctx, W, y, 'ワゴンの説明');
    const GAP = 16;
    const innerW = W - PAD * 2;
    const cols = Math.max(1, Math.min(4, Math.floor((innerW + GAP) / (440 + GAP))));
    const cw = (innerW - GAP * (cols - 1)) / cols;
    const cards = [{ engine: true }, ...[...m.wagons].reverse().map(e => ({ e }))]; // エンジン → #1 → …

    // 石積み配置: 各カードを一番短い列に積む(長さの違うカードでも隙間ができない)
    const colY = Array(cols).fill(y);
    cards.forEach(c => {
      const h = descCard(ctx, 0, 0, cw, c, m, opts, false);
      const k = colY.indexOf(Math.min(...colY));
      const x = PAD + k * (cw + GAP);
      rr(ctx, x, colY[k], cw, h, 14);
      ctx.fillStyle = 'rgba(27,33,48,.92)'; ctx.fill();
      ctx.strokeStyle = C.edge; ctx.lineWidth = 1.5; ctx.stroke();
      descCard(ctx, x, colY[k], cw, c, m, opts, true);
      colY[k] += h + GAP;
    });
    return Math.max(...colY);
  }

  // D=false の時は高さだけ計算する(描かない)
  function descCard(ctx, x0, y0, w, card, m, opts, D){
    const P = 16, iw = w - P * 2;
    let y = y0 + P;
    const T = (s, xx, cy, font, color, align) => { if (D) text(ctx, s, xx, cy, font, color, align); };
    const para = (s, font, color, lh, indent = 0) => {
      ctx.font = font;
      wrap(ctx, s, iw - indent).forEach(l => { T(l, x0 + P + indent, y + lh / 2, font, color); y += lh; });
    };
    const sec = label => {
      y += 10;
      T(label, x0 + P, y + 8, F(11.5, 800), C.muted);
      y += 18;
      if (D) { ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(x0 + P, y, iw, 1); }
      y += 7;
    };
    const chip = (label, color, xx, cy) => {
      ctx.font = F(10, 800);
      const bw = ctx.measureText(label).width + 16;
      if (D) {
        rr(ctx, xx, cy - 9, bw, 18, 9);
        ctx.save(); ctx.globalAlpha = .15; ctx.fillStyle = color; ctx.fill(); ctx.restore();
        ctx.strokeStyle = color; ctx.globalAlpha = .6; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
        text(ctx, label, xx + bw / 2, cy, F(10, 800), color, 'center');
      }
      return bw;
    };
    const table = rows => {
      ctx.font = F(12, 700);
      const kw = Math.min(iw * .45, Math.max(...rows.map(r => ctx.measureText(r[0]).width)) + 16);
      rows.forEach(([k, v, nx]) => {
        T(k, x0 + P, y + 10, F(12, 700), C.muted);
        T(v, x0 + P + kw, y + 10, F(12, 600), C.cream);
        if (nx) {
          ctx.font = F(12, 600);
          const vw = ctx.measureText(v).width;
          T(nx.s, x0 + P + kw + vw + 6, y + 10, F(12, nx.same ? 500 : 800), nx.same ? 'rgba(154,163,178,.6)' : C.teal);
        }
        y += 20;
      });
    };

    if (card.engine) {
      const eng = m.eng;
      if (D) drawFit(ctx, IMG(eng.icon), x0 + P, y, 56, 40);
      ctx.font = F(17, 800);
      const nm = ellipsis(ctx, eng.name_ja, iw - 66 - 70);
      T(nm, x0 + P + 66, y + 20, F(17, 800), C.cream);
      ctx.font = F(17, 800);
      chip('エンジン', CAT_COLOR.engine, x0 + P + 66 + ctx.measureText(nm).width + 8, y + 20);
      y += 48;
      if (eng.description) para(`“${eng.description}”`, F(13, 500), C.gold, 21);
      const rows = [['初期ワゴン数', eng.initial_wagons], ['水の容量', eng.water_capacity], ['開始速度', eng.start_speed]]
        .filter(r => r[1]).map(r => [r[0], String(r[1])]);
      if (rows.length) { sec('基本性能'); table(rows); }
      if (eng.notes) { sec('特性'); para(eng.notes, F(12.5, 500), 'rgba(246,236,217,.88)', 20); }
      return y + P - y0;
    }

    const e = card.e, def = e.def;
    // 見出し
    if (D) drawFit(ctx, IMG(e.icon), x0 + P, y, 44, 40);
    ctx.font = F(10, 800);
    const catLabel = CAT_LABEL[def.category] || def.category;
    const chipW = ctx.measureText(catLabel).width + 16;
    ctx.font = F(16, 800);
    const title = ellipsis(ctx, `#${e.no} ${def.name_ja}`, iw - 54 - chipW - 8);
    T(title, x0 + P + 54, y + 12, F(16, 800), C.cream);
    ctx.font = F(16, 800);
    chip(catLabel, CAT_COLOR[def.category] || C.muted, x0 + P + 54 + ctx.measureText(title).width + 8, y + 12);
    T(e.plus.total > 0 ? `Lv.${e.w.level} → 実効 Lv.${e.effLv}` : `Lv.${e.w.level}`, x0 + P + 54, y + 32, F(12, 700), C.muted);
    y += 48;

    if (def.game_description) para(`“${def.game_description}”`, F(13, 500), C.gold, 21);
    if (def.description) para(def.description, F(13, 500), 'rgba(246,236,217,.88)', 21);
    if (def.levelup_summary) para('📈 ' + def.levelup_summary, F(12, 500), 'rgba(246,236,217,.6)', 19);

    // 消費資材
    if (e.consume) {
      y += 4;
      let ix = x0 + P;
      e.consume.keys.forEach(k => { if (D) drawFit(ctx, IMG(matIcon(k)), ix, y + 1, 18, 18); ix += 20; });
      T('消費資材: ' + e.consume.label, ix + 4, y + 10, F(12, 700), C.cream);
      y += 22;
    }

    // オーラ(自分が出す効果 / 受けている効果)
    const swatch = (color, label) => {
      if (D) { rr(ctx, x0 + P, y + 4, 12, 12, 3); ctx.fillStyle = color; ctx.fill(); }
      ctx.font = F(12, 700);
      wrap(ctx, label, iw - 20).forEach(l => { T(l, x0 + P + 20, y + 10, F(12, 700), C.cream); y += 20; });
    };
    if (def.aura) {
      const lvForRange = Math.min(e.w.level + e.plus.pusher + e.plus.parts, maxLevel(def));
      const ent = levelEntry(def, lvForRange);
      const r = parseInt(ent && ent.stats && ent.stats[def.aura.stat_key], 10) || 0;
      swatch(AURA_STYLE[def.aura.type].color, `前後 ${r} 台に効果(${def.aura.note})`);
    }
    const received = [...new Set(e.bands.map(b => b.type))].filter(t => !(def.aura && def.aura.type === t));
    if (received.length) { sec('受けている効果'); received.forEach(t => swatch(AURA_STYLE[t].color, AURA_STYLE[t].label)); }

    // ステータス(実効レベル)
    const cur = levelEntry(def, e.dispLv);
    if (cur && cur.stats) {
      const next = levelEntry(def, e.dispLv + 1);
      let head;
      if (e.plus.total > 0) {
        const d = [`基本 Lv.${e.w.level}`];
        if (e.plus.pusher) d.push(`推進式 +${e.plus.pusher}`);
        if (e.plus.charge) d.push(`チャージワゴン +${e.plus.charge}`);
        if (e.plus.parts)  d.push(`拡張パーツ +${e.plus.parts}`);
        head = `実効 Lv.${e.effLv} のステータス(${d.join(' / ')})`;
      } else head = `Lv.${e.dispLv} のステータス`;
      if (next) head += `  → は Lv.${next.level} の値`;
      y += 10;
      ctx.font = F(11.5, 800);
      wrap(ctx, head, iw).forEach(l => { T(l, x0 + P, y + 8, F(11.5, 800), C.muted); y += 17; });
      if (D) { ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(x0 + P, y + 1, iw, 1); }
      y += 8;
      if (e.effLv > maxLevel(def)) {
        para(`⚠ Lv.${e.effLv} のデータは wiki 未収録のため、収録上限 Lv.${maxLevel(def)} の値を表示しています`, F(11, 600), C.gold, 17);
      }
      table(Object.entries(cur.stats).map(([k, v]) => {
        let nx = null;
        if (next && next.stats && k in next.stats) nx = next.stats[k] !== v ? { s: '→ ' + next.stats[k] } : { s: '→ 変化なし', same: true };
        return [k, String(v), nx];
      }));
    }

    // 装着中の拡張パーツ(説明付き)
    if (e.parts.length) {
      sec('装着中の拡張パーツ');
      e.parts.forEach(pid => {
        if (D) drawFit(ctx, IMG(extIcon(pid)), x0 + P, y + 1, 18, 18);
        T(EXT_NAME[pid] || pid, x0 + P + 24, y + 10, F(12, 800), C.cream);
        y += 21;
        const info = EXT_INFO[pid];
        if (info && info.description) para(info.description, F(11.5, 500), C.muted, 18, 24);
        y += 3;
      });
    }

    // 拡張パーツ対応表(任意)
    if (opts.compat && def.expansion_parts) {
      sec('拡張パーツ対応');
      const entries = Object.entries(def.expansion_parts);
      const colW = iw / 2;
      entries.forEach(([pid, p], k) => {
        const cx = x0 + P + (k % 2) * colW, cy = y + Math.floor(k / 2) * 20;
        T(p.compatible ? '⭕' : '×', cx, cy + 10, F(11, 800), p.compatible ? C.green : '#777f8d');
        if (D) drawFit(ctx, IMG(extIcon(pid)), cx + 18, cy + 2, 16, 16);
        ctx.font = F(11.5, 600);
        T(ellipsis(ctx, EXT_NAME[pid] || p.name_ja, colW - 44), cx + 38, cy + 10, F(11.5, 600), p.compatible ? C.cream : C.muted);
      });
      y += Math.ceil(entries.length / 2) * 20;
    }

    // 作者メモ
    if (e.w.memo) {
      sec('作者メモ');
      ctx.font = F(12.5, 600);
      const lines = wrap(ctx, e.w.memo, iw - 20);
      const bh = lines.length * 19 + 14;
      if (D) {
        rr(ctx, x0 + P, y, iw, bh, 9);
        ctx.fillStyle = 'rgba(255,206,74,.08)'; ctx.fill();
        ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(255,206,74,.45)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
      }
      lines.forEach((l, k) => T(l, x0 + P + 10, y + 7 + 9.5 + k * 19, F(12.5, 600), C.gold));
      y += bh;
    }

    // tips(任意)
    const tips = opts.tips ? tipsFor(def) : [];
    if (tips.length) {
      sec(`💡 tips (${tips.length})`);
      tips.forEach(t => {
        T('•', x0 + P + 2, y + 9.5, F(12, 800), C.muted);
        para(t, F(12, 500), 'rgba(246,236,217,.82)', 19, 14);
        y += 4;
      });
    }
    return y + P - y0;
  }

  /* ---------- 画像を生成 ---------- */
  async function renderBuildPng(opts){
    const m = buildModel();
    await preload(m);
    await loadFonts(m);
    const W = Math.max(MIN_W, Math.ceil(trainWidth(m) + PAD * 2));
    // 1回目: 高さを測る(小さなキャンバスに描いて捨てる)
    const H = Math.ceil(paint(document.createElement('canvas').getContext('2d'), W, 0, m, opts));
    // 2倍解像度で描く。巨大すぎる場合はブラウザの上限に収まるよう縮める
    let s = 2;
    const LIMIT = 16000, AREA = 2.5e8;
    while (s > 1 && (W * s > LIMIT || H * s > LIMIT || W * s * H * s > AREA)) s -= .25;
    if (W * s > LIMIT || H * s > LIMIT || W * s * H * s > AREA) s = Math.min(LIMIT / W, LIMIT / H, Math.sqrt(AREA / (W * H)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(W * s); canvas.height = Math.round(H * s);
    const ctx = canvas.getContext('2d');
    ctx.scale(s, s);
    paint(ctx, W, H, m, opts);
    return canvas;
  }

  /* ---------- 保存 ---------- */
  async function saveBlob(blob, name){
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: name, id: 'u2bv-png', startIn: 'pictures',
          types: [{ description: 'PNG画像', accept: { 'image/png': ['.png'] } }],
        });
        const ws = await handle.createWritable();
        await ws.write(blob); await ws.close();
        return 'saved';
      } catch (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    return 'downloaded';
  }

  /* ---------- ダイアログ ---------- */
  function loadOpts(){
    const def = { desc:false, tips:true, compat:false };
    try { return { ...def, ...(JSON.parse(localStorage.getItem(OPTS_KEY)) || {}) }; } catch { return def; }
  }
  function saveOpts(o){ try { localStorage.setItem(OPTS_KEY, JSON.stringify(o)); } catch {} }

  let seq = 0, lastBlob = null;

  async function refresh(){
    const my = ++seq;
    const o = { desc: $('#pngDesc').checked, tips: $('#pngTips').checked, compat: $('#pngCompat').checked };
    saveOpts(o);
    $('#pngSub').classList.toggle('off', !o.desc);
    $('#pngOk').disabled = true;
    $('#pngSize').textContent = '生成中…';
    try {
      const canvas = await renderBuildPng(o);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      if (my !== seq || !$('#pngPreview')) return; // 途中で設定を変えた/閉じた
      lastBlob = blob;
      const pv = $('#pngPreview');
      pv.innerHTML = '';
      pv.appendChild(canvas);
      $('#pngSize').textContent = `${canvas.width} × ${canvas.height}px ・ ${(blob.size / 1024 / 1024).toFixed(2)}MB`;
      $('#pngOk').disabled = false;
    } catch (e) {
      console.error(e);
      if (my === seq && $('#pngSize')) $('#pngSize').textContent = '画像の生成に失敗しました';
    }
  }

  function openPngDialog(){
    if (!state.wagons.length) { toast('ワゴンを追加してから画像にしてください'); return; }
    const o = loadOpts();
    lastBlob = null;
    dlgBox.classList.add('wide');
    dlgBox.innerHTML = `
      <h4>🖼 画像で保存 <span class="hint">PNG</span></h4>
      <div class="png-preview" id="pngPreview"><div class="hint" style="padding:30px">生成中…</div></div>
      <label class="chk"><input type="checkbox" id="pngDesc"${o.desc ? ' checked' : ''}> ワゴンの説明を下に付ける</label>
      <div class="chk-sub" id="pngSub">
        <label class="chk"><input type="checkbox" id="pngTips"${o.tips ? ' checked' : ''}> tips も含める</label>
        <label class="chk"><input type="checkbox" id="pngCompat"${o.compat ? ' checked' : ''}> 拡張パーツ対応表も含める</label>
      </div>
      <div class="dlg-btns">
        <span class="hint" id="pngSize" style="margin-right:auto;align-self:center"></span>
        <button class="btn subtle" id="dlgCancel">閉じる</button>
        <button class="btn primary" id="pngOk" disabled>💾 PNGで保存</button>
      </div>`;
    ['#pngDesc', '#pngTips', '#pngCompat'].forEach(s => $(s).onchange = refresh);
    $('#dlgCancel').onclick = closeDialog;
    $('#pngOk').onclick = async () => {
      if (!lastBlob) return;
      const fname = ((state.name || 'build').replace(/[\\/:*?"<>|#&\s]+/g, '_') || 'build') + '.png';
      const r = await saveBlob(lastBlob, fname);
      if (r === 'cancelled') return;
      closeDialog();
      toast(r === 'saved' ? `${fname} を保存しました` : `${fname} をダウンロードしました`);
    };
    dlgOverlay.classList.add('show');
    refresh();
  }

  window.openPngDialog = openPngDialog;
  window.renderBuildPng = renderBuildPng; // 動作確認用
})();
