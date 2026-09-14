/* =========================================================
 * Unrailed! 2 Build Viewer
 * データソース: data/wagons.json (唯一のデータソース・ハードコード禁止)
 * 完全クライアントサイド。外部ストレージは localStorage のみ。
 * ========================================================= */
'use strict';

/* ===== 定数 ===== */
const LS_EDITOR   = 'u2bv:editor';    // 「編集者として記憶」フラグ
const LS_SLOTS    = 'u2bv:slots';     // 名前付き保存スロット
const LS_AUTOSAVE = 'u2bv:autosave';  // 編集中の自動保存
const LS_TIPSOVR  = 'u2bv:tipsovr';   // tips のローカル上書き(作者編集用)
const MAX_WAGONS  = 24;
const BASE_EXT_SLOTS = 3;             // 拡張パーツの基本枠数
const MAX_EXT_SLOTS  = 6;             // 追加枠を含めた上限
const MAX_BASE_LEVEL = 6;             // ワゴン自体のレベル上限(それ以上はブーストでのみ到達)

// ワゴンレベル下部ラインの色 (meta.level_line_colors: 1=灰/2=黄緑/3=水色/4=紫/5=黄/6+=赤)
const LEVEL_COLORS = { 1:'#8f97a6', 2:'#7ad24a', 3:'#4ac6e0', 4:'#a86ae8', 5:'#ffd23e' };
const levelColor = lv => lv >= 6 ? '#ff5252' : (LEVEL_COLORS[lv] || '#8f97a6');

// オーラ(隣接干渉)の配色 — ゴースト=青系 / チャージ=金系 / 推進式=緑系
const AURA_STYLE = {
  ghost:       { color:'#57c8ff', label:'ゴースト(透明化)' },
  supercharge: { color:'#ffce4a', label:'スーパーチャージ(+1Lv)' },
  pusher:      { color:'#7ad24a', label:'推進式エンジン(+2Lv)' },
};

/* 資材フロー矢印を発生させる拡張パーツ。
 * ワゴン間の物資移動は拡張パーツがないと起こらない(手描き矢印はなし)。
 * - storage-pull: 最も近い貨物ワゴンから資材を引き抜く(貨物 → 自分)
 * - storage-push: 最も近い貨物ワゴンへ資材を送る(自分 → 貨物)
 * - front-pull  : 前方(先頭側)の隣のワゴンから資材を引き出す(前方 → 自分) */
const FLOW_PARTS = {
  'storage-pull': { color:'#6fce5e' },
  'storage-push': { color:'#ff7a3d' },
  'front-pull':   { color:'#57b0ff' },
};
const STORAGE_ID = 'storage'; // 貨物ワゴンの id

const CAT_LABEL = { normal:'通常', special:'特殊', versus:'対戦' };

/* ===== グローバル状態 ===== */
let DATA = null;           // wagons.json
let wagonById = {};        // id -> 定義
let engineById = {};       // id -> 定義
let EXT_LIST = [];         // [{id, name_ja}] 拡張パーツ13種(wagons.jsonから抽出)
let EXT_NAME = {};         // id -> name_ja (expansions.json の表記を優先)
let EXT_INFO = {};         // id -> { name_ja, description, level_plus } (data/expansions.json)
let MAT_INFO = { icons:{}, labels:{}, consumes:{} }; // data/materials.json (消費資材)
let TIPS_REPO = {};        // data/tips_overrides.json (リポジトリに置く公開用のtips上書き)
let TIPS_LOCAL = {};       // localStorage のtips上書き(作者のローカル編集)

// ビルド状態 (canonical 形式)
let state = emptyState();
let editMode = true;       // 実効の編集モード
let forcePreview = false;  // 編集者向け「プレビュー確認」トグル
let autosaveEnabled = false;

// ライブ同期 (?live=<id>)
let LIVE = null;              // live.js が公開する API (未設定なら null)
let liveId = null;            // 同期しているビルドID
let liveUnsub = null;         // 購読解除用
let liveAutoPublish = false;  // 編集のたびに自動で公開するか
let liveLastUpdated = null;   // 最終更新時刻(サーバー時刻)

// UI 一時状態
let currentCat = 'normal';
let dragIdx = null;        // DnD 中のワゴン index

function emptyState(){
  return { v:2, name:'', concept:'', tags:[], engine:'steam', enginePos:0, wagons:[] };
}
// ワゴン追加時の初期拡張パーツ。クラフトワゴンはゲーム開始時から
// 貨物引き寄せ(storage-pull)が1枠目に搭載されている。
// ゴースト急行使用時はさらにゴーストが1枠目に付く(外すことも可能)。
function defaultExt(id){
  const ext = Array(BASE_EXT_SLOTS).fill(null);
  if (id === 'crafter') ext[0] = 'storage-pull';
  if (state.engine === 'ghost') insertGhostPart({ ext });
  return ext;
}
// ゴーストパーツを1枠目に挿入(既に持っていれば何もしない)
function insertGhostPart(w){
  if (w.ext.includes('ghost')) return;
  if (w.ext.length >= MAX_EXT_SLOTS && !w.ext.includes(null)) return; // 全枠埋まっている場合は諦める
  w.ext.unshift('ghost');
  if (w.ext.length > MAX_EXT_SLOTS) {
    const ni = w.ext.lastIndexOf(null);
    w.ext.splice(ni, 1);
  }
}
// ゴーストパーツを取り除く(エンジンをゴースト急行から切り替えたとき用)
function removeGhostPart(w){
  const idx = w.ext.indexOf('ghost');
  if (idx < 0) return;
  w.ext.splice(idx, 1);
  while (w.ext.length < BASE_EXT_SLOTS) w.ext.push(null);
}

/* ===== ユーティリティ ===== */
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function toast(msg){
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._tm); toast._tm = setTimeout(() => t.classList.remove('show'), 2200);
}

function wagonIcon(def, lv){
  if (!def.icon) return null;
  if (typeof def.icon === 'string') return def.icon;
  return def.icon[String(Math.min(lv, 6))] || def.icon['6'] || def.icon['1'] || null;
}
function extIcon(id){ return `assets/expansions/${id}.png`; }
function levelEntry(def, lv){ return (def.levels || []).find(l => l.level === lv) || null; }
function maxLevel(def){ return def.levels && def.levels.length ? Math.max(...def.levels.map(l => l.level)) : 1; }
function isEditing(){ return editMode && !forcePreview; }

/* tips: ローカル上書き > リポジトリの上書きファイル > wiki原文 の順で採用 */
function tipsFor(def){
  const t = TIPS_LOCAL[def.id] ?? TIPS_REPO[def.id] ?? def.tips ?? [];
  return t.filter(Boolean);
}

/* 消費資材 (data/materials.json)。木材+鉄の両方は mixed アイコンにまとめ、
 * レールを扱える場合(マグネット等)は追加で並べる。 */
function consumeSpec(id){
  const list = MAT_INFO.consumes[id];
  if (!list || !list.length) return null;
  const set = new Set(list);
  const keys = [];
  if (set.has('wood') && set.has('iron')) keys.push('mixed');
  else if (set.has('wood')) keys.push('wood');
  else if (set.has('iron')) keys.push('iron');
  // レール・動物などその他の資材はそのまま追加
  list.forEach(k => { if (k !== 'wood' && k !== 'iron' && !keys.includes(k)) keys.push(k); });
  if (!keys.length) return null;
  return { keys, label: keys.map(k => MAT_INFO.labels[k] || k).join('・') };
}
function matIcon(key){ return MAT_INFO.icons[key] || MAT_INFO.icons.mixed; }

/* ===== ビルド形式の正規化 (URL用の短縮形 / builds/ 用の読みやすい形の両対応) ===== */
function normalizeBuild(o){
  const s = emptyState();
  if (!o || typeof o !== 'object') return s;
  s.name    = String(o.name ?? o.n ?? '');
  s.concept = String(o.concept ?? o.c ?? '');
  s.tags    = (o.tags ?? o.t ?? []).map(String).filter(Boolean);
  const eng = String(o.engine ?? o.e ?? 'steam');
  s.engine  = engineById[eng] ? eng : 'steam';
  const rawW = o.wagons ?? o.w ?? [];
  s.wagons = rawW.map(w => {
    if (Array.isArray(w)) w = { id:w[0], level:w[1], memo:w[2], ext:w[3] };
    const def = wagonById[w.id]; if (!def) return null;
    const lv = Math.max(1, Math.min(MAX_BASE_LEVEL, maxLevel(def), parseInt(w.level, 10) || 1));
    let ext;
    if (Array.isArray(w.ext)) {
      ext = w.ext.slice(0, MAX_EXT_SLOTS).map(p => (p && EXT_NAME[p]) ? p : null);
      while (ext.length < BASE_EXT_SLOTS) ext.push(null);
      while (ext.length > BASE_EXT_SLOTS && ext[ext.length - 1] === null) ext.pop(); // 追加枠の末尾空きは畳む
    } else {
      ext = defaultExt(w.id); // 旧形式データからの移行
    }
    return { id:w.id, level:lv, memo:String(w.memo ?? ''), ext };
  }).filter(Boolean).slice(0, MAX_WAGONS);
  const p = parseInt(o.enginePos ?? o.p, 10);
  s.enginePos = Number.isFinite(p) ? Math.max(0, Math.min(s.wagons.length, p)) : s.wagons.length;
  if (s.engine !== 'pusher') s.enginePos = s.wagons.length; // 推進式以外は先頭固定
  return s;
}
function minifyState(){
  return { v:2, n:state.name, c:state.concept, t:state.tags, e:state.engine, p:state.enginePos,
    w:state.wagons.map(w => [w.id, w.level, w.memo || undefined, w.ext.some(Boolean) ? w.ext : undefined]) };
}

/* ===== URL エンコード/デコード (deflate + Base64URL / 非対応環境は無圧縮) ===== */
function b64u(bytes){
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(str){
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}
async function encodeBuild(){
  const bytes = new TextEncoder().encode(JSON.stringify(minifyState()));
  if (typeof CompressionStream !== 'undefined') {
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
    return '1.' + b64u(new Uint8Array(buf));
  }
  return '0.' + b64u(bytes);
}
async function decodeBuild(str){
  const dot = str.indexOf('.');
  const ver = str.slice(0, dot), payload = str.slice(dot + 1);
  const bytes = unb64u(payload);
  let json;
  if (ver === '1') {
    const buf = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
    json = new TextDecoder().decode(buf);
  } else {
    json = new TextDecoder().decode(bytes);
  }
  return JSON.parse(json);
}

/* ===== オーラ(隣接干渉)とレベルブーストの計算 =====
 * 返り値:
 *   bands[i] : ワゴン i に掛かるオーラ帯 [{type, src}]
 *   plus[i]  : { pusher, charge, parts, total } レベル加算値
 * - ゴースト/スーパーチャージは現在レベルの stats[隣接範囲] を読んで前後N台に効果。
 * - スーパーチャージワゴンは範囲内のワゴンのレベル+1(自分自身には効果なし)。
 * - 推進式エンジンは隣接ワゴン(前後1台)のレベル+2。
 * - 拡張パーツのスーパーチャージ(+1)/ハイドロチャージ(+2)は装着したワゴン自身に加算
 *   (加算値は data/expansions.json の level_plus)。
 * - チャージワゴン自身の隣接範囲は推進式・自身のパーツのブースト込みレベルで判定する。 */
function computeEffects(){
  const n = state.wagons.length;
  const pusherPlus = Array(n).fill(0);
  if (state.engine === 'pusher') {
    [state.enginePos - 1, state.enginePos].forEach(k => { if (k >= 0 && k < n) pusherPlus[k] = 2; });
  }
  const partsPlus = state.wagons.map(w =>
    w.ext.reduce((sum, p) => sum + ((p && EXT_INFO[p] && EXT_INFO[p].level_plus) || 0), 0));
  const bands = Array.from({ length:n }, () => []);
  const chargePlus = Array(n).fill(0);
  state.wagons.forEach((w, i) => {
    const def = wagonById[w.id];
    if (!def || !def.aura) return;
    const lvForRange = Math.min(w.level + pusherPlus[i] + partsPlus[i], maxLevel(def));
    const ent = levelEntry(def, lvForRange);
    const r = parseInt(ent && ent.stats && ent.stats[def.aura.stat_key], 10) || 0;
    for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) {
      bands[k].push({ type: def.aura.type, src: k === i });
      if (def.aura.type === 'supercharge' && k !== i) chargePlus[k] += 1;
    }
  });
  if (state.engine === 'pusher') {
    [state.enginePos - 1, state.enginePos].forEach(k => {
      if (k >= 0 && k < n) bands[k].push({ type:'pusher', src:false });
    });
  }
  const plus = state.wagons.map((w, i) => ({
    pusher: pusherPlus[i], charge: chargePlus[i], parts: partsPlus[i],
    total: pusherPlus[i] + chargePlus[i] + partsPlus[i],
  }));
  return { bands, plus };
}

/* ===== 資材フロー(拡張パーツから自動生成) ===== */
function computeFlows(){
  const n = state.wagons.length;
  const flows = [];
  const storageIdx = [];
  state.wagons.forEach((w, i) => { if (w.id === STORAGE_ID) storageIdx.push(i); });
  // 最も近い貨物ワゴン。等距離なら先頭側(右/大きいindex)を優先
  const nearestStorage = i => {
    let best = null, bd = Infinity;
    for (const k of storageIdx) {
      if (k === i) continue;
      const d = Math.abs(k - i);
      if (d < bd || (d === bd && (best === null || k > best))) { bd = d; best = k; }
    }
    return best;
  };
  state.wagons.forEach((w, i) => {
    w.ext.forEach(p => {
      if (!p || !FLOW_PARTS[p]) return;
      if (p === 'storage-pull') {
        // 全ての貨物ワゴンから引き寄せる(最寄りは優先されるだけ)
        const near = nearestStorage(i);
        storageIdx.forEach(k => {
          if (k !== i) flows.push({ from:k, to:i, part:p, priority: k === near });
        });
      }
      else if (p === 'storage-push') { const k = nearestStorage(i); if (k !== null) flows.push({ from:i, to:k, part:p, priority:true }); }
      else if (p === 'front-pull') { if (i + 1 < n) flows.push({ from:i + 1, to:i, part:p, priority:true }); }
    });
  });
  return flows;
}

/* ===== 描画: メタ情報 ===== */
function renderMeta(){
  const bar = $('#metaBar');
  document.title = (state.name ? state.name + ' — ' : '') + 'Unrailed! 2 Build Viewer';
  if (isEditing()) {
    bar.innerHTML = `
      <div class="meta-row">
        <span class="meta-label">ビルド名</span>
        <input type="text" id="buildName" placeholder="例: エンドレス採掘特化ビルド" value="${esc(state.name)}">
        <span class="meta-label">タグ(カンマ区切り)</span>
        <input type="text" id="buildTags" placeholder="例: エンドレス, 4人用" value="${esc(state.tags.join(', '))}">
      </div>
      <textarea id="buildConcept" placeholder="コンセプト説明(複数行可)。プレビューではヘッダーに表示されます。">${esc(state.concept)}</textarea>`;
    $('#buildName').oninput = e => { state.name = e.target.value; autosave(); document.title = (state.name ? state.name + ' — ' : '') + 'Unrailed! 2 Build Viewer'; };
    $('#buildTags').oninput = e => { state.tags = e.target.value.split(/[,、]/).map(s => s.trim()).filter(Boolean); autosave(); };
    $('#buildConcept').oninput = e => { state.concept = e.target.value; autosave(); };
  } else {
    const tags = state.tags.map(t => `<span class="tag-chip">${esc(t)}</span>`).join('');
    bar.innerHTML = `<div class="meta-view">
      <span class="bname">${esc(state.name) || '無題のビルド'}</span>${tags}
      ${state.concept ? `<div class="concept">${esc(state.concept)}</div>` : ''}
    </div>`;
  }
}

/* ===== 描画: 列車 ===== */
function renderTrain(){
  const train = $('#train');
  train.innerHTML = '';
  const n = state.wagons.length;
  if (state.engine !== 'pusher') state.enginePos = n;
  const fx = computeEffects();

  if (n === 0 && isEditing()) {
    const hint = document.createElement('div');
    hint.className = 'empty-train';
    hint.textContent = '↓ 下のパレットからワゴンをクリックして編成をつくりましょう(右が先頭です)';
    train.appendChild(hint);
  }

  // 左→右の並び。enginePos の隙間にエンジンを挿入(右端=先頭)
  const items = [];
  for (let i = 0; i < n; i++) {
    if (state.enginePos === i) items.push({ t:'engine' });
    items.push({ t:'wagon', i });
  }
  if (state.enginePos >= n) items.push({ t:'engine' });

  items.forEach((it, k) => {
    if (k > 0) train.appendChild(Object.assign(document.createElement('div'), { className:'coupler' }));
    train.appendChild(it.t === 'engine' ? engineCell() : wagonCell(it.i, fx));
  });

  drawArrows(); // getBoundingClientRect が同期でレイアウトを確定させるので直接呼んでよい
}

function engineCell(){
  const def = engineById[state.engine];
  const ec = document.createElement('div');
  ec.className = 'engine-cell';
  const isFront = state.enginePos >= state.wagons.length;
  const movable = isEditing() && state.engine === 'pusher';
  ec.innerHTML = `
    <div class="epad"><img src="${esc(def.icon)}" alt="${esc(def.name_ja)}" loading="lazy"></div>
    <div class="cap">${esc(def.name_ja)}${isFront ? ' <span class="front">(先頭)</span>' : ''}</div>
    ${movable ? `<div class="mover">
      <button data-d="-1" ${state.enginePos <= 0 ? 'disabled' : ''} title="左へ">◀</button>
      <button data-d="1" ${state.enginePos >= state.wagons.length ? 'disabled' : ''} title="右へ">▶</button>
    </div>` : ''}`;
  ec.querySelectorAll('.mover button').forEach(b => b.onclick = ev => {
    ev.stopPropagation();
    state.enginePos = Math.max(0, Math.min(state.wagons.length, state.enginePos + (+b.dataset.d)));
    autosave(); renderTrain();
  });
  bindTip(ec.querySelector('.epad'), () => engineTipHTML(def));
  return ec;
}

function wagonCell(i, fx){
  const w = state.wagons[i];
  const def = wagonById[w.id];
  const n = state.wagons.length;
  const cell = document.createElement('div');
  cell.className = 'wagon-cell';
  cell.dataset.i = i;

  // オーラの種類を重複排除(同種オーラが複数ソースから届いても帯は1本)
  const seen = {};
  (fx.bands[i] || []).forEach(a => {
    if (!seen[a.type]) seen[a.type] = { type:a.type, src:false };
    if (a.src) seen[a.type].src = true;
  });
  const auraTypes = Object.values(seen);
  const plus = fx.plus[i];

  // 実効レベル(チャージ/推進式ブースト込み)。アイコン・下端ライン・ツールチップの
  // ステータスはこの実効レベルのものを表示する。
  const effLv = w.level + plus.total;
  const dispLv = Math.min(effLv, maxLevel(def));

  const wb = document.createElement('div');
  wb.className = 'wbox' + auraTypes.filter(a => a.src).map(a => ` aura-src-${a.type}`).join('');
  const icon = wagonIcon(def, dispLv);
  // バッジは実効レベルのレベルカラーで表示(例: Lv3+1 → Lv4の紫)
  const badgeBg = levelColor(effLv);
  const badgeFg = (effLv === 4 || effLv >= 6) ? '#fff' : '#1c2230';
  wb.innerHTML = `
    <span class="idx">#${n - i}</span>
    ${w.memo ? '<span class="memo-mark" title="作者メモあり">📝</span>' : ''}
    ${plus.total > 0 ? `<span class="plusbadge" style="background:${badgeBg};color:${badgeFg}" title="実効 Lv.${effLv}">+${plus.total}Lv</span>` : ''}
    ${icon ? `<img src="${esc(icon)}" alt="${esc(def.name_ja)}" loading="lazy">` : ''}
    <div class="aura-stack">${auraTypes.map(a =>
      `<div class="aura-band${a.src ? ' src' : ''}" style="background:${AURA_STYLE[a.type].color};color:${AURA_STYLE[a.type].color}"></div>`).join('')}</div>
    <div class="lvline" style="background:${levelColor(effLv)}"></div>`;
  bindTip(wb, () => wagonTipHTML(i));
  cell.appendChild(wb);

  const nm = document.createElement('div');
  nm.className = 'wname'; nm.textContent = def.name_ja;
  cell.appendChild(nm);

  // レベル表示。編集モードのみセレクタ、プレビューでは固定表示ですっきりさせる
  const lvrow = document.createElement('div');
  lvrow.className = 'lvrow';
  if (def.levels && def.levels.length) {
    if (isEditing()) {
      const sel = document.createElement('select');
      sel.className = 'lvsel'; sel.title = 'レベル';
      // ワゴン自体のレベルは6が上限(7以上はチャージ等のブーストでのみ到達)
      def.levels.filter(l => l.level <= MAX_BASE_LEVEL).forEach(l => {
        const op = document.createElement('option');
        op.value = l.level; op.textContent = 'Lv.' + l.level;
        if (l.level === w.level) op.selected = true;
        sel.appendChild(op);
      });
      sel.onchange = () => { w.level = parseInt(sel.value, 10); autosave(); renderAll(); };
      lvrow.appendChild(sel);
    } else {
      const st = document.createElement('span');
      st.className = 'lvstatic';
      st.textContent = 'Lv.' + w.level + (plus.total > 0 ? `→${effLv}` : '');
      st.title = plus.total > 0 ? `実効 Lv.${effLv}` : `レベル ${w.level}`;
      lvrow.appendChild(st);
    }
  }
  // 消費資材アイコン(効果の発揮に資材が必要なワゴン)
  const cs = consumeSpec(w.id);
  if (cs) {
    const cr = document.createElement('span');
    cr.className = 'consume-row';
    cr.title = '消費資材: ' + cs.label;
    cr.innerHTML = cs.keys.map(k => `<img src="${esc(matIcon(k))}" alt="${esc(MAT_INFO.labels[k] || k)}" loading="lazy">`).join('');
    lvrow.appendChild(cr);
  }
  cell.appendChild(lvrow);

  cell.appendChild(extRow(i));

  // 編集列
  if (isEditing()) {
    const er = document.createElement('div');
    er.className = 'editrow';
    er.innerHTML = `
      <button data-act="left"  title="左(後方)へ" ${i <= 0 ? 'disabled' : ''}>◀</button>
      <button data-act="memo"  title="メモを編集">📝</button>
      <button data-act="del" class="del" title="削除">✕</button>
      <button data-act="right" title="右(前方)へ" ${i >= n - 1 ? 'disabled' : ''}>▶</button>`;
    er.querySelectorAll('button').forEach(b => b.onclick = ev => {
      ev.stopPropagation();
      const act = b.dataset.act;
      if (act === 'left'  && i > 0)     moveWagon(i, i - 1);
      if (act === 'right' && i < n - 1) moveWagon(i, i + 1);
      if (act === 'del') removeWagon(i);
      if (act === 'memo') openMemoDialog(i);
    });
    cell.appendChild(er);

    // ドラッグ&ドロップ並べ替え
    cell.draggable = true;
    cell.addEventListener('dragstart', () => { dragIdx = i; cell.classList.add('dragging'); });
    cell.addEventListener('dragend',   () => { dragIdx = null; cell.classList.remove('dragging'); });
    cell.addEventListener('dragover',  ev => { ev.preventDefault(); cell.classList.add('drag-over'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
    cell.addEventListener('drop', ev => {
      ev.preventDefault(); cell.classList.remove('drag-over');
      if (dragIdx !== null && dragIdx !== i) moveWagon(dragIdx, i);
    });
  }
  return cell;
}

/* ===== 拡張パーツスロット ===== */
function extRow(i){
  const w = state.wagons[i];
  const row = document.createElement('div');
  row.className = 'ext-row';
  w.ext.forEach((pid, si) => {
    const slot = document.createElement('div');
    slot.className = 'ext-slot' + (pid ? ' filled' : '');
    if (pid) {
      slot.innerHTML = `<img src="${esc(extIcon(pid))}" alt="${esc(EXT_NAME[pid] || pid)}" loading="lazy">`;
      // ホバーで名前+説明のツールチップを表示(タッチ環境の編集中はピッカー優先)
      if (!(isTouch && isEditing())) bindTip(slot, () => extTipHTML(pid));
    } else {
      slot.title = '拡張スロット' + (isEditing() ? '(クリックで装着)' : '');
    }
    if (isEditing()) {
      slot.onclick = ev => { ev.stopPropagation(); openExtDialog(i, si); };
    }
    row.appendChild(slot);
  });
  if (isEditing()) {
    if (w.ext.length < MAX_EXT_SLOTS) {
      const add = document.createElement('button');
      add.className = 'ext-add'; add.textContent = '+'; add.title = '拡張枠を追加(4枠以上載る場合用)';
      add.onclick = ev => { ev.stopPropagation(); w.ext.push(null); autosave(); renderAll(); };
      row.appendChild(add);
    }
    if (w.ext.length > BASE_EXT_SLOTS && w.ext[w.ext.length - 1] === null) {
      const rm = document.createElement('button');
      rm.className = 'ext-add'; rm.textContent = '−'; rm.title = '追加した空き枠を減らす';
      rm.onclick = ev => { ev.stopPropagation(); w.ext.pop(); autosave(); renderAll(); };
      row.appendChild(rm);
    }
  }
  return row;
}

function openExtDialog(i, slotIdx){
  const w = state.wagons[i];
  const def = wagonById[w.id];
  const cur = w.ext[slotIdx];
  const compatMark = pid => {
    const p = def.expansion_parts && def.expansion_parts[pid];
    if (!p) return '<span class="cmp unknown" title="wikiに対応可否の記載なし">?</span>';
    return p.compatible
      ? '<span class="cmp ok">⭕</span>'
      : '<span class="cmp ng" title="wikiでは装着不可(×)とされています">×</span>';
  };
  dlgBox.innerHTML = `
    <h4>拡張パーツを選択 — ${esc(def.name_ja)} <span class="hint">枠${slotIdx + 1}</span></h4>
    <div class="ext-grid">
      <div class="ext-pick none${cur === null ? ' on' : ''}" data-p=""><span style="font-size:18px">∅</span><span class="pn">なし(外す)</span></div>
      ${EXT_LIST.map(p => `
        <div class="ext-pick${cur === p.id ? ' on' : ''}" data-p="${esc(p.id)}" title="${esc(EXT_INFO[p.id]?.description || '')}">
          <img src="${esc(extIcon(p.id))}" alt="" loading="lazy">
          <span class="pn">${esc(EXT_NAME[p.id] || p.name_ja)}</span>${compatMark(p.id)}
        </div>`).join('')}
    </div>
    <div class="hint" style="margin-bottom:10px">⭕/× は wiki 記載の対応可否。×でも装着自体は選べます(自己責任)。</div>
    <div class="dlg-btns"><button class="btn subtle" id="dlgCancel">閉じる</button></div>`;
  dlgBox.querySelectorAll('.ext-pick').forEach(el => el.onclick = () => {
    w.ext[slotIdx] = el.dataset.p || null;
    closeDialog(); autosave(); renderAll();
  });
  $('#dlgCancel').onclick = closeDialog;
  dlgOverlay.classList.add('show');
}

/* ===== ワゴン操作 ===== */
function addWagon(id){
  if (!isEditing()) return;
  if (state.wagons.length >= MAX_WAGONS) { toast(`ワゴンは最大 ${MAX_WAGONS} 台までです`); return; }
  // 新規ワゴンは編成の最後尾(エンジンから最も遠い端)に連結する
  state.wagons.unshift({ id, level:1, memo:'', ext: defaultExt(id) });
  if (state.engine === 'pusher') state.enginePos = Math.min(state.enginePos + 1, state.wagons.length);
  else state.enginePos = state.wagons.length;
  autosave(); renderAll();
}
function removeWagon(i){
  state.wagons.splice(i, 1);
  if (state.enginePos > i) state.enginePos--;
  autosave(); renderAll();
}
// i の要素を j の位置へ移動(隣接なら入れ替えと同じ)
function moveWagon(i, j){
  const [item] = state.wagons.splice(i, 1);
  state.wagons.splice(j, 0, item);
  if (state.engine !== 'pusher') state.enginePos = state.wagons.length;
  else state.enginePos = Math.max(0, Math.min(state.wagons.length, state.enginePos));
  autosave(); renderAll();
}

/* ===== 資材フロー矢印(コの字型・拡張パーツから自動生成) ===== */
function wagonCenterX(i){
  const cell = $(`.wagon-cell[data-i="${i}"]`);
  if (!cell) return null;
  const r = cell.querySelector('.wbox').getBoundingClientRect();
  const sr = $('.stage').getBoundingClientRect();
  return r.left - sr.left + r.width / 2;
}
const SVGNS = 'http://www.w3.org/2000/svg';
function drawArrows(){
  const svg = $('#arrowSvg');
  svg.innerHTML = '';
  const flows = computeFlows();
  if (!flows.length) { renderLegend(flows); return; }

  // レーン割り当て(区間が重なる矢印は上のレーンへ)
  const planned = flows.map((f, fi) => ({ ...f, fi, lo: Math.min(f.from, f.to), hi: Math.max(f.from, f.to) }));
  planned.sort((p, q) => p.lo - q.lo || p.hi - q.hi);
  const lanes = [];
  planned.forEach(p => {
    let L = 0;
    for (;; L++) {
      if (!lanes[L]) { lanes[L] = []; break; }
      if (!lanes[L].some(([lo, hi]) => p.lo < hi && lo < p.hi)) break;
    }
    lanes[L].push([p.lo, p.hi]); p.lane = L;
  });

  const H = 120, baseY = H - 6, laneGap = 15; // レーンの段差は控えめに
  const defs = document.createElementNS(SVGNS, 'defs');
  Object.entries(FLOW_PARTS).forEach(([k, fp]) => {
    const mk = document.createElementNS(SVGNS, 'marker');
    mk.setAttribute('id', 'mk-' + k); mk.setAttribute('viewBox', '0 0 10 10');
    mk.setAttribute('refX', '8'); mk.setAttribute('refY', '5');
    mk.setAttribute('markerWidth', '7'); mk.setAttribute('markerHeight', '7');
    mk.setAttribute('orient', 'auto-start-reverse');
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', 'M0 0 L10 5 L0 10 z'); p.setAttribute('fill', fp.color);
    mk.appendChild(p); defs.appendChild(mk);
  });
  svg.appendChild(defs);

  planned.forEach(p => {
    const x1 = wagonCenterX(p.from), x2 = wagonCenterX(p.to);
    if (x1 == null || x2 == null) return;
    const apex = baseY - 16 - p.lane * laneGap;
    const col = FLOW_PARTS[p.part].color;
    // コの字型(直角)の動線: 上へ → 横へ → 下へ
    const d = `M ${x1} ${baseY - 6} L ${x1} ${apex} L ${x2} ${apex} L ${x2} ${baseY - 6}`;
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('id', 'arc-' + p.fi); path.setAttribute('d', d);
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', col);
    path.setAttribute('stroke-width', '2.6');
    path.setAttribute('stroke-linejoin', 'miter'); path.setAttribute('stroke-linecap', 'square');
    path.setAttribute('marker-end', `url(#mk-${p.part})`);
    if (!p.priority) { // 優先度の低い経路(遠い貨物ワゴンからの引き寄せ)は破線で
      path.setAttribute('stroke-dasharray', '6 5');
      path.setAttribute('opacity', '.55');
    }
    svg.appendChild(path);

    // 資材アイコンが矢印に沿って移動する。引き寄せ系は受け取り側の消費資材、
    // それ以外は汎用の資材アイコン(Commodities)を流す。
    let moverKeys = ['mixed'];
    if (p.part === 'storage-pull' || p.part === 'front-pull') {
      const csp = consumeSpec(state.wagons[p.to] && state.wagons[p.to].id);
      if (csp) moverKeys = csp.keys;
    }
    const g = document.createElementNS(SVGNS, 'g');
    moverKeys.slice(0, 2).forEach((k, ki) => {
      const img = document.createElementNS(SVGNS, 'image');
      const href = matIcon(k);
      img.setAttribute('href', href);
      img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', href);
      img.setAttribute('width', '17'); img.setAttribute('height', '17');
      img.setAttribute('x', String(-8 + ki * 15)); img.setAttribute('y', '-9');
      g.appendChild(img);
    });
    if (!p.priority) g.setAttribute('opacity', '.55');
    const am = document.createElementNS(SVGNS, 'animateMotion');
    am.setAttribute('dur', '2.2s'); am.setAttribute('repeatCount', 'indefinite');
    const mp = document.createElementNS(SVGNS, 'mpath');
    mp.setAttribute('href', '#arc-' + p.fi);
    mp.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#arc-' + p.fi);
    am.appendChild(mp); g.appendChild(am); svg.appendChild(g);

    // ホバー用の太い透明パス(説明表示)
    const hit = document.createElementNS(SVGNS, 'path');
    hit.setAttribute('d', d); hit.setAttribute('fill', 'none');
    hit.setAttribute('stroke', 'rgba(0,0,0,0)'); hit.setAttribute('stroke-width', '16');
    hit.setAttribute('class', 'hit');
    let label = `${flowEndName(p.from)} → ${flowEndName(p.to)}｜${EXT_NAME[p.part] || p.part}`;
    if (p.part === 'storage-pull') label += p.priority ? '(最寄り・優先)' : '(遠い方からも引き寄せ)';
    hit.addEventListener('mouseenter', ev => showFlowTip(label, ev.clientX, ev.clientY));
    hit.addEventListener('mousemove',  ev => showFlowTip(label, ev.clientX, ev.clientY));
    hit.addEventListener('mouseleave', hideFlowTip);
    svg.appendChild(hit);
  });
  renderLegend(flows);
}
function flowEndName(i){
  const w = state.wagons[i];
  return w ? `#${state.wagons.length - i} ${wagonById[w.id].name_ja}` : '?';
}
let flowTipEl = null;
function showFlowTip(text, x, y){
  if (!flowTipEl) {
    flowTipEl = document.createElement('div');
    Object.assign(flowTipEl.style, {
      position:'fixed', zIndex:90, background:'#2a3347', color:'#f6ecd9', fontSize:'11.5px',
      fontWeight:'700', borderRadius:'9px', padding:'5px 10px', pointerEvents:'none',
      border:'1px solid #43505f', boxShadow:'0 6px 18px rgba(0,0,0,.5)', maxWidth:'320px',
    });
    document.body.appendChild(flowTipEl);
  }
  flowTipEl.textContent = text;
  flowTipEl.style.display = 'block';
  flowTipEl.style.left = Math.min(x + 14, innerWidth - 330) + 'px';
  flowTipEl.style.top = (y + 14) + 'px';
}
function hideFlowTip(){ if (flowTipEl) flowTipEl.style.display = 'none'; }

/* ===== 凡例 (使用中のフローとオーラ) ===== */
function renderLegend(flows){
  const lg = $('#legend');
  const parts = [...new Set(flows.map(f => f.part))];
  const auraTypes = new Set();
  state.wagons.forEach(w => { const d = wagonById[w.id]; if (d && d.aura) auraTypes.add(d.aura.type); });
  if (state.engine === 'pusher' && state.wagons.length) auraTypes.add('pusher');
  let html = '';
  parts.forEach(p => { html += `<span class="it"><span class="ln" style="border-color:${FLOW_PARTS[p].color}"></span>${esc(EXT_NAME[p] || p)}</span>`; });
  auraTypes.forEach(a => { html += `<span class="it"><span class="ln" style="border-top-width:5px;border-color:${AURA_STYLE[a].color}"></span>${esc(AURA_STYLE[a].label)}の効果範囲</span>`; });
  lg.innerHTML = html;
  lg.style.display = html ? '' : 'none';
}

/* ===== ツールチップ / 詳細パネル ===== */
const tip = $('#tip');
let tipHideTimer = null;
const isTouch = matchMedia('(hover: none)').matches;

function bindTip(el, buildHTML){
  if (isTouch) {
    el.addEventListener('click', ev => {
      ev.stopPropagation();
      $('#tipBody').innerHTML = buildHTML();
      tip.classList.add('show');
    });
    return;
  }
  el.addEventListener('mouseenter', () => {
    clearTimeout(tipHideTimer);
    $('#tipBody').innerHTML = buildHTML();
    tip.classList.add('show');
    positionTip(el);
  });
  el.addEventListener('mouseleave', scheduleTipHide);
}
function scheduleTipHide(){
  clearTimeout(tipHideTimer);
  tipHideTimer = setTimeout(() => tip.classList.remove('show'), 180);
}
tip.addEventListener('mouseenter', () => clearTimeout(tipHideTimer));
tip.addEventListener('mouseleave', scheduleTipHide);
$('#tipClose').onclick = () => tip.classList.remove('show');
document.addEventListener('click', ev => {
  if (isTouch && !tip.contains(ev.target)) tip.classList.remove('show');
});

// 画面端で見切れないように配置
function positionTip(anchor){
  const r = anchor.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = r.right + 10;
  if (x + tw > innerWidth - 8) x = r.left - tw - 10;
  if (x < 8) x = Math.min(Math.max(8, r.left), innerWidth - tw - 8);
  let y = r.top;
  if (y + th > innerHeight - 8) y = innerHeight - th - 8;
  if (y < 8) y = 8;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}

/* 実効レベル(ブースト込み)のステータス表。
 * データが収録上限を超える場合はその旨を注釈し、上限レベルの値を表示する。 */
function statsTableHTML(def, baseLv, plus){
  const effLv = baseLv + plus.total;
  const dispLv = Math.min(effLv, maxLevel(def));
  const cur = levelEntry(def, dispLv);
  if (!cur || !cur.stats) return '';
  const next = levelEntry(def, dispLv + 1);
  const rows = Object.entries(cur.stats).map(([k, v]) => {
    let nx = '';
    if (next && next.stats && k in next.stats) {
      nx = next.stats[k] !== v
        ? ` <span class="next">→ ${esc(next.stats[k])}</span>`
        : ' <span class="same">→ 変化なし</span>';
    }
    return `<tr><td class="k">${esc(k)}</td><td>${esc(v)}${nx}</td></tr>`;
  }).join('');
  let head;
  if (plus.total > 0) {
    const detail = [`基本 Lv.${baseLv}`];
    if (plus.pusher) detail.push(`推進式 +${plus.pusher}`);
    if (plus.charge) detail.push(`チャージワゴン +${plus.charge}`);
    if (plus.parts)  detail.push(`拡張パーツ +${plus.parts}`);
    head = `実効 Lv.${effLv} のステータス <span style="font-weight:500">(${detail.join(' / ')})</span>`;
  } else {
    head = `Lv.${dispLv} のステータス`;
  }
  const nextCap = next ? `<span style="font-weight:500">(→ は Lv.${next.level} の値)</span>` : '';
  const overCap = effLv > maxLevel(def)
    ? `<div class="hint" style="color:var(--gold)">⚠ Lv.${effLv} のデータは wiki 未収録のため、収録上限 Lv.${maxLevel(def)} の値を表示しています</div>` : '';
  return `<div class="sec">${head} ${nextCap}</div>${overCap}<table>${rows}</table>`;
}
function partsHTML(def){
  if (!def.expansion_parts) return '';
  const items = Object.entries(def.expansion_parts).map(([pid, p]) =>
    `<span class="part" title="${esc(EXT_INFO[pid]?.description || '')}">${p.compatible ? '<span class="ok">⭕</span>' : '<span class="ng">×</span>'}
     <img class="part-ic" src="${esc(extIcon(pid))}" alt="" loading="lazy">
     ${esc(EXT_NAME[pid] || p.name_ja)}${p.note_ref ? `<span class="ref" title="wiki脚注 ${esc(p.note_ref)} 参照">${esc(p.note_ref)}</span>` : ''}</span>`).join('');
  return `<div class="sec">拡張パーツ対応</div><div class="parts">${items}</div>`;
}
function wagonTipHTML(i){
  const w = state.wagons[i];
  const def = wagonById[w.id];
  const fx = computeEffects();
  const seen = new Set((fx.bands[i] || []).map(a => a.type));
  const plus = fx.plus[i];
  let auraHtml = '';
  if (def.aura) {
    const lvForRange = Math.min(w.level + plus.pusher + plus.parts, maxLevel(def));
    const ent = levelEntry(def, lvForRange);
    const r = parseInt(ent && ent.stats && ent.stats[def.aura.stat_key], 10) || 0;
    auraHtml += `<div class="aura-info"><span class="sw" style="background:${AURA_STYLE[def.aura.type].color}"></span>
      前後 ${r} 台に効果(${esc(def.aura.note)})</div>`;
  }
  const received = [...seen].filter(t => !(def.aura && def.aura.type === t));
  if (received.length) {
    auraHtml += `<div class="sec">受けている効果</div>` + received.map(t =>
      `<div class="aura-info"><span class="sw" style="background:${AURA_STYLE[t].color}"></span>${esc(AURA_STYLE[t].label)}</div>`).join('');
  }
  // 装着中の拡張パーツ
  const equipped = w.ext.filter(Boolean);
  const extHtml = equipped.length
    ? `<div class="sec">装着中の拡張パーツ</div><div class="parts">${equipped.map(pid =>
        `<span class="part" title="${esc(EXT_INFO[pid]?.description || '')}"><img class="part-ic" src="${esc(extIcon(pid))}" alt="">${esc(EXT_NAME[pid] || pid)}</span>`).join('')}</div>`
    : '';
  const tips = tipsFor(def);
  const tipsEdited = TIPS_LOCAL[def.id] != null || TIPS_REPO[def.id] != null;
  const tipsEditLink = isEditing()
    ? ` <a href="#" class="tips-edit" data-id="${esc(def.id)}" style="font-size:10.5px">✎ 編集</a>` : '';
  const tipsSec = (tips.length || isEditing())
    ? `<details><summary>💡 tips (${tips.length})${tipsEdited ? ' <span style="color:var(--gold)">※編集済</span>' : ''}${tipsEditLink}</summary>
       <ul class="tips-list">${tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul></details>` : '';
  return `
    <h3>${esc(def.name_ja)} <span class="cat ${esc(def.category)}">${CAT_LABEL[def.category] || esc(def.category)}</span></h3>
    ${def.game_description ? `<div class="gamedesc">“${esc(def.game_description)}”</div>` : ''}
    ${def.description ? `<div class="desc">${esc(def.description)}</div>` : ''}
    ${def.levelup_summary ? `<div class="desc" style="opacity:.7">📈 ${esc(def.levelup_summary)}</div>` : ''}
    ${(() => { const c = consumeSpec(w.id); return c ? `<div class="aura-info">${c.keys.map(k =>
      `<img class="part-ic" src="${esc(matIcon(k))}" alt="">`).join('')} 消費資材: ${esc(c.label)}</div>` : ''; })()}
    ${auraHtml}
    ${statsTableHTML(def, w.level, plus)}
    ${extHtml}
    ${partsHTML(def)}
    ${tipsSec}
    ${w.memo ? `<div class="sec">作者メモ</div><div class="memo">${esc(w.memo)}</div>` : ''}
    ${def.wiki_url ? `<div class="sec"></div><a href="${esc(def.wiki_url)}" target="_blank" rel="noopener">wiki で詳細を見る ↗</a>` : ''}`;
}
function extTipHTML(pid){
  const info = EXT_INFO[pid] || {};
  const plus = info.level_plus ? `<div class="aura-info">⚡ このワゴンのレベル +${info.level_plus}</div>` : '';
  return `
    <h3><img class="part-ic" style="width:22px;height:22px" src="${esc(extIcon(pid))}" alt=""> ${esc(EXT_NAME[pid] || pid)} <span class="cat special">拡張パーツ</span></h3>
    ${info.description ? `<div class="desc">${esc(info.description)}</div>` : '<div class="hint">説明データなし</div>'}
    ${plus}`;
}
function engineTipHTML(def){
  const rows = [
    ['初期ワゴン数', def.initial_wagons],
    ['水の容量', def.water_capacity], ['開始速度', def.start_speed],
  ].filter(([, v]) => v).map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
  return `
    <h3>${esc(def.name_ja)} <span class="cat normal">エンジン</span></h3>
    ${def.description ? `<div class="gamedesc">“${esc(def.description)}”</div>` : ''}
    <div class="sec">基本性能</div><table>${rows}</table>
    ${def.notes ? `<div class="sec">特性</div><div class="desc">${esc(def.notes)}</div>` : ''}`;
}

/* ===== パレット(編集モード) ===== */
function renderPalette(){
  const pal = $('#palette');
  pal.hidden = !isEditing();
  if (!isEditing()) return;

  // エンジン選択
  const et = $('#engineTabs');
  et.innerHTML = '<span class="meta-label" style="align-self:center">エンジン:</span>';
  DATA.engines.forEach(e => {
    const d = document.createElement('div');
    d.className = 'pal-item';
    d.style.width = '86px'; d.style.height = '58px';
    if (e.id === state.engine) { d.style.borderColor = 'var(--gold)'; }
    d.innerHTML = `<img src="${esc(e.icon)}" alt="" loading="lazy"><span class="pn">${esc(e.name_ja)}</span>`;
    d.title = e.name_ja;
    d.onclick = () => {
      const prev = state.engine;
      state.engine = e.id;
      if (e.id !== 'pusher') state.enginePos = state.wagons.length;
      // ゴースト急行: 各ワゴンの1枠目にゴーストパーツを付与(手動で外すことも可能)。
      // 他のエンジンへ戻したら自動付与分は取り除く。
      if (e.id === 'ghost' && prev !== 'ghost') state.wagons.forEach(insertGhostPart);
      if (e.id !== 'ghost' && prev === 'ghost') state.wagons.forEach(removeGhostPart);
      autosave(); renderAll();
    };
    et.appendChild(d);
  });

  // カテゴリタブ + トレイ
  document.querySelectorAll('#catTabs .tab').forEach(t => {
    t.classList.toggle('on', t.dataset.cat === currentCat);
    t.onclick = () => { currentCat = t.dataset.cat; renderPalette(); };
  });
  const tray = $('#tray');
  tray.innerHTML = '';
  DATA.wagons.filter(w => w.category === currentCat).forEach(w => {
    const d = document.createElement('div');
    d.className = 'pal-item';
    const icon = wagonIcon(w, 1);
    d.innerHTML = `${icon ? `<img src="${esc(icon)}" alt="" loading="lazy">` : ''}<span class="pn">${esc(w.name_ja)}</span>`;
    d.title = w.name_ja + '(クリックで追加)';
    d.onclick = () => addWagon(w.id);
    tray.appendChild(d);
  });
}

/* ===== ダイアログ ===== */
const dlgOverlay = $('#dlgOverlay');
const dlgBox = $('#dlgBox');
function closeDialog(){ dlgOverlay.classList.remove('show'); dlgBox.innerHTML = ''; dlgBox.className = 'dlg'; }
dlgOverlay.addEventListener('click', ev => { if (ev.target === dlgOverlay) closeDialog(); });

function openMemoDialog(i){
  const w = state.wagons[i];
  dlgBox.innerHTML = `
    <h4>作者メモ — ${esc(wagonById[w.id].name_ja)} <span class="hint">#${state.wagons.length - i}</span></h4>
    <textarea id="memoText" placeholder="このビルドでの役割・コンセプトなど(ツールチップに表示されます)">${esc(w.memo)}</textarea>
    <div class="dlg-btns">
      <button class="btn subtle" id="dlgCancel">キャンセル</button>
      <button class="btn primary" id="dlgOk">保存</button>
    </div>`;
  $('#dlgCancel').onclick = closeDialog;
  $('#dlgOk').onclick = () => {
    w.memo = $('#memoText').value.trim();
    closeDialog(); autosave(); renderAll();
  };
  dlgOverlay.classList.add('show');
  $('#memoText').focus();
}

/* ===== tips の編集(作者用) =====
 * ローカル(localStorage)に上書きを保存し、「上書きJSONをダウンロード」で
 * data/tips_overrides.json としてリポジトリに置けば全閲覧者に反映される。 */
function saveTipsLocal(){
  try { localStorage.setItem(LS_TIPSOVR, JSON.stringify(TIPS_LOCAL)); } catch {}
}
function openTipsDialog(id){
  const def = wagonById[id];
  if (!def) return;
  const cur = tipsFor(def);
  dlgBox.innerHTML = `
    <h4>tips を編集 — ${esc(def.name_ja)}</h4>
    <div class="hint" style="margin-bottom:6px">1行につき1項目。空にすると tips 非表示になります。<br>
      保存先はこのブラウザ(localStorage)。サイト公開に反映するには下のボタンで
      JSON を書き出し、リポジトリの <b>data/tips_overrides.json</b> に置いてください。</div>
    <textarea id="tipsText" style="min-height:140px">${esc(cur.join('\n'))}</textarea>
    <div class="dlg-btns" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
      <span>
        <button class="btn subtle" id="tipsRevert" title="このワゴンのローカル編集を破棄してwiki原文(またはリポジトリの上書き)に戻す">↺ 原文に戻す</button>
        <button class="btn subtle" id="tipsExport" title="全ワゴン分の上書きを tips_overrides.json として保存">⤓ 上書きJSONをダウンロード</button>
      </span>
      <span>
        <button class="btn subtle" id="dlgCancel">キャンセル</button>
        <button class="btn primary" id="dlgOk">保存</button>
      </span>
    </div>`;
  $('#dlgCancel').onclick = closeDialog;
  $('#dlgOk').onclick = () => {
    TIPS_LOCAL[id] = $('#tipsText').value.split('\n').map(s => s.trim()).filter(Boolean);
    saveTipsLocal(); closeDialog(); toast('tips を保存しました(このブラウザ内)');
  };
  $('#tipsRevert').onclick = () => {
    delete TIPS_LOCAL[id];
    saveTipsLocal(); closeDialog(); toast('原文に戻しました');
  };
  $('#tipsExport').onclick = async () => {
    const merged = { ...TIPS_REPO, ...TIPS_LOCAL };
    const r = await saveJsonFile(merged, 'tips_overrides.json', 'u2bv-data');
    if (r === 'cancelled') return;
    toast('data/ ディレクトリに置いて公開してください');
  };
  dlgOverlay.classList.add('show');
  $('#tipsText').focus();
}
// ツールチップ内の「✎ 編集」リンク(内容は都度生成されるため委譲で拾う)
$('#tipBody').addEventListener('click', ev => {
  const a = ev.target.closest('.tips-edit');
  if (!a) return;
  ev.preventDefault();
  tip.classList.remove('show');
  openTipsDialog(a.dataset.id);
});

/* JSON を「名前を付けて保存」ダイアログで保存する。
 * File System Access API 対応ブラウザ(Chrome/Edge)では dirId ごとに前回の保存先を記憶するので、
 * 一度 builds/ を選べば次回からそのフォルダが最初から開く。
 * 非対応ブラウザ(Safari 等)や未許可時は従来どおりダウンロードにフォールバックする。
 * 返り値: 'saved' | 'downloaded' | 'cancelled' */
async function saveJsonFile(obj, suggestedName, dirId){
  const text = JSON.stringify(obj, null, 2);
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName, id: dirId, startIn: 'documents',
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      });
      const ws = await handle.createWritable();
      await ws.write(text);
      await ws.close();
      return 'saved';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled'; // ユーザーがキャンセル
      // それ以外(未許可・セキュリティ制限等)は下のダウンロードにフォールバック
    }
  }
  const blob = new Blob([text], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = suggestedName; a.click();
  URL.revokeObjectURL(a.href);
  return 'downloaded';
}

/* ===== 保存スロット (localStorage) ===== */
function loadSlots(){ try { return JSON.parse(localStorage.getItem(LS_SLOTS)) || {}; } catch { return {}; } }
function renderSlotsPanel(){
  const p = $('#slotsPanel');
  const slots = loadSlots();
  const names = Object.keys(slots).sort();
  p.innerHTML = `<h4>💾 保存スロット <span class="hint">(このブラウザ内に保存)</span></h4>
    ${names.length ? '' : '<div class="hint">保存されたビルドはまだありません</div>'}
    ${names.map(n => `
      <div class="slot-row" data-n="${esc(n)}">
        <span class="nm">${esc(n)}</span>
        <span class="dt">${esc((slots[n].savedAt || '').slice(0, 10))}</span>
        <button class="btn small" data-act="load">開く</button>
        <button class="btn small subtle" data-act="del">削除</button>
      </div>`).join('')}
    <div class="newrow">
      <input type="text" id="slotName" placeholder="スロット名" value="${esc(state.name || '')}">
      <button class="btn small primary" id="slotSave">現在のビルドを保存</button>
    </div>
    <div style="margin-top:12px;border-top:1px solid rgba(255,255,255,.08);padding-top:10px">
      <div class="hint" style="margin-bottom:6px">📌 <b>更新できる固定URLで配布</b>: 書き出したJSONをリポジトリの
        <b>builds/</b> に保存すると <b>?build=ファイル名.json</b> で共有できます。
        ファイルを上書きすれば、閲覧者は再読み込みだけで最新ビルドが見られます。<br>
        <span style="opacity:.8">※ 初回だけ保存先に builds フォルダを選べば、次回から自動でそこが開きます(Chrome/Edge)。</span></div>
      <button class="btn small" id="slotExport">⤓ 現在のビルドをJSONで書き出し</button>
    </div>`;
  p.querySelectorAll('.slot-row button').forEach(b => b.onclick = () => {
    const n = b.closest('.slot-row').dataset.n;
    if (b.dataset.act === 'load') {
      state = normalizeBuild(slots[n].build);
      renderAll(); renderSlotsPanel();
      toast(`「${n}」を読み込みました`);
    } else {
      delete slots[n];
      localStorage.setItem(LS_SLOTS, JSON.stringify(slots));
      renderSlotsPanel();
    }
  });
  $('#slotSave').onclick = () => {
    const n = $('#slotName').value.trim() || '無題のビルド';
    slots[n] = { savedAt: new Date().toISOString(), build: state };
    localStorage.setItem(LS_SLOTS, JSON.stringify(slots));
    renderSlotsPanel();
    toast(`「${n}」に保存しました`);
  };
  // builds/ ディレクトリ配布用のJSON書き出し(固定URLで最新版を配信できる)
  $('#slotExport').onclick = async () => {
    // ファイル名はビルド名から生成(ファイル名/URLに使えない文字は _ に置換)
    const fname = ((state.name || 'build').replace(/[\\/:*?"<>|#&\s]+/g, '_') || 'build') + '.json';
    const r = await saveJsonFile(state, fname, 'u2bv-builds');
    if (r === 'cancelled') return;
    toast(r === 'saved'
      ? `${fname} を保存しました。commit → push で公開されます`
      : `${fname} を書き出しました。builds/ に置いて ?build=${fname} で共有できます`);
  };
}

/* ===== 自動保存 ===== */
function autosave(){
  if (autosaveEnabled) {
    try { localStorage.setItem(LS_AUTOSAVE, JSON.stringify(state)); } catch {}
  }
  scheduleLivePublish(); // 自動公開ONなら、少し待ってからライブにも反映
}

/* ===== ライブ同期 (?live=<id>) ===== */

/* 閲覧者側: ホストの変更を購読して画面を自動更新する */
function startLiveSubscribe(){
  if (!LIVE || !LIVE.configured || !liveId || liveUnsub) return;
  let first = true;
  liveUnsub = LIVE.subscribe(liveId, rec => {
    if (first) { first = false; return; } // 初回分は起動時に取得済みなので捨てる
    if (!rec || !rec.state) return;
    state = normalizeBuild(rec.state);
    liveLastUpdated = rec.updatedAt || Date.now();
    renderAll();
    toast('🔄 ホストがビルドを更新しました');
  });
}

/* ホスト側: 現在のビルドを公開(上書き) */
let livePublishTimer = null;
async function livePublish(silent){
  if (!LIVE || !LIVE.configured || !liveId) return;
  if (!LIVE.user()) { openLoginDialog(); return; }
  try {
    await LIVE.publish(liveId, state);
    liveLastUpdated = Date.now();
    if (!silent) toast('📡 ライブに公開しました(閲覧者の画面がすぐ更新されます)');
    renderHeader();
  } catch (e) {
    console.error(e);
    toast(e && e.code === 'PERMISSION_DENIED'
      ? '公開権限がありません(ホストのアカウントでログインしてください)'
      : '公開に失敗しました: ' + (e && (e.code || e.message)));
  }
}
/* 自動公開: 編集が落ち着いてからまとめて送る(打つたびに送らない) */
function scheduleLivePublish(){
  if (!liveAutoPublish || !liveId || !LIVE || !LIVE.user()) return;
  clearTimeout(livePublishTimer);
  livePublishTimer = setTimeout(() => livePublish(true), 1200);
}

/* ホストのログイン(閲覧者には不要) */
function openLoginDialog(){
  dlgBox.innerHTML = `
    <h4>🔑 ホストとしてログイン</h4>
    <div class="hint" style="margin-bottom:8px">ライブ公開するにはログインが必要です。<br>
      ビルドを見るだけの人はログイン不要です。</div>
    <input type="email" id="liveEmail" placeholder="メールアドレス" autocomplete="username">
    <input type="password" id="livePass" placeholder="パスワード" autocomplete="current-password">
    <div class="dlg-btns">
      <button class="btn subtle" id="dlgCancel">キャンセル</button>
      <button class="btn primary" id="dlgOk">ログイン</button>
    </div>`;
  $('#dlgCancel').onclick = closeDialog;
  $('#dlgOk').onclick = async () => {
    const email = $('#liveEmail').value.trim();
    const pw = $('#livePass').value;
    if (!email || !pw) { toast('メールアドレスとパスワードを入力してください'); return; }
    $('#dlgOk').disabled = true;
    try {
      await LIVE.signIn(email, pw);
      closeDialog();
      toast('ログインしました');
      renderHeader();
    } catch (e) {
      console.error(e);
      $('#dlgOk').disabled = false;
      toast('ログインできませんでした(メールアドレスかパスワードをご確認ください)');
    }
  };
  dlgOverlay.classList.add('show');
  $('#liveEmail').focus();
}

/* ヘッダーのライブ関連UI */
function renderLiveUI(){
  const on = !!(liveId && LIVE && LIVE.configured);
  const editing = isEditing();
  const signedIn = on && !!LIVE.user();
  const badge = $('#liveBadge');
  badge.hidden = !on;
  $('#livePublishBtn').hidden = !(on && editing);
  $('#liveAutoBtn').hidden    = !(on && editing);
  $('#liveAccountBtn').hidden = !(on && editing);
  if (!on) return;
  badge.textContent = editing ? `📡 LIVE : ${liveId}` : '🟢 LIVE同期中';
  badge.title = liveLastUpdated
    ? '最終更新: ' + new Date(liveLastUpdated).toLocaleString('ja-JP') : 'ホストの更新を待機中';
  $('#liveAutoBtn').classList.toggle('on', liveAutoPublish);
  $('#liveAccountBtn').textContent = signedIn ? '👤 ログアウト' : '🔑 ログイン';
}

/* ===== ヘッダーのボタン類 ===== */
function renderHeader(){
  const editing = isEditing();
  const badge = $('#modeBadge');
  badge.className = 'mode-badge ' + (editing ? 'edit' : 'preview');
  badge.textContent = editing ? 'EDIT' : 'PREVIEW';
  document.body.classList.toggle('editing', editing);
  $('#shareBtn').hidden = !editing;
  $('#slotsBtn').hidden = !editing;
  $('#rememberBtn').hidden = !editing;
  $('#previewToggleBtn').hidden = !editMode;
  $('#previewToggleBtn').textContent = forcePreview ? '✏ 編集に戻る' : '👁 プレビュー確認';
  $('#copyEditWrap').hidden = editing;
  $('#rememberBtn').classList.toggle('on', localStorage.getItem(LS_EDITOR) === '1');
  if (!editing) $('#slotsPanel').classList.remove('show');
  renderLiveUI();
}

function bindHeaderButtons(){
  $('#shareBtn').onclick = async () => {
    if (!state.wagons.length) { toast('ワゴンを追加してから共有してください'); return; }
    const enc = await encodeBuild();
    const url = location.origin + location.pathname + '#b=' + enc;
    history.replaceState(null, '', '#b=' + enc + '&edit=1'); // 自分のURLは編集付きで維持
    try {
      await navigator.clipboard.writeText(url);
      toast('共有URLをコピーしました(開いた人はプレビュー表示になります)');
    } catch {
      prompt('このURLをコピーしてください:', url);
    }
  };
  $('#slotsBtn').onclick = () => {
    const p = $('#slotsPanel');
    p.classList.toggle('show');
    if (p.classList.contains('show')) renderSlotsPanel();
  };
  $('#rememberBtn').onclick = () => {
    const on = localStorage.getItem(LS_EDITOR) === '1';
    if (on) { localStorage.removeItem(LS_EDITOR); toast('編集者フラグを解除しました'); }
    else { localStorage.setItem(LS_EDITOR, '1'); toast('このブラウザを編集者として記憶しました(共有URLを開いても編集UIが出ます)'); }
    renderHeader();
  };
  $('#previewToggleBtn').onclick = () => {
    forcePreview = !forcePreview;
    renderAll();
  };
  $('#copyEditLink').onclick = async ev => {
    ev.preventDefault();
    const enc = await encodeBuild();
    location.hash = 'b=' + enc + '&edit=1';
    location.reload();
  };
  /* --- 画像出力(export-png.js) --- */
  $('#pngBtn').onclick = () => { if (window.openPngDialog) window.openPngDialog(); };
  /* --- ライブ同期 --- */
  $('#livePublishBtn').onclick = () => livePublish(false);
  $('#liveAutoBtn').onclick = () => {
    liveAutoPublish = !liveAutoPublish;
    toast(liveAutoPublish ? '自動公開ON(編集するたびに自動で反映します)' : '自動公開OFF');
    if (liveAutoPublish) livePublish(true);
    renderHeader();
  };
  $('#liveAccountBtn').onclick = async () => {
    if (LIVE && LIVE.user()) {
      await LIVE.signOut();
      liveAutoPublish = false;
      toast('ログアウトしました');
      renderHeader();
    } else {
      openLoginDialog();
    }
  };
}

/* ===== 全体描画 ===== */
function renderAll(){
  renderHeader();
  renderMeta();
  renderTrain();
  renderPalette();
}

/* ===== 起動 ===== */
async function main(){
  const res = await fetch('data/wagons.json');
  DATA = await res.json();
  DATA.wagons.forEach(w => { wagonById[w.id] = w; });
  DATA.engines.forEach(e => { engineById[e.id] = e; });
  // 拡張パーツ13種の一覧を expansion_parts を持つワゴンから抽出(キー順を維持)
  const src = DATA.wagons.find(w => w.expansion_parts);
  EXT_LIST = Object.entries(src.expansion_parts).map(([id, p]) => ({ id, name_ja: p.name_ja }));
  EXT_LIST.forEach(p => { EXT_NAME[p.id] = p.name_ja; });
  // 拡張パーツの説明・効果 (data/expansions.json)。表示名はこちらを優先
  try {
    const ex = await (await fetch('data/expansions.json')).json();
    EXT_INFO = ex.parts || {};
    Object.entries(EXT_INFO).forEach(([id, p]) => { if (p.name_ja) EXT_NAME[id] = p.name_ja; });
  } catch (e) { console.warn('data/expansions.json を読み込めませんでした', e); }
  // 消費資材 (data/materials.json)
  try {
    const m = await (await fetch('data/materials.json')).json();
    MAT_INFO = { icons: m.icons || {}, labels: m.labels || {}, consumes: m.consumes || {} };
  } catch (e) { console.warn('data/materials.json を読み込めませんでした', e); }
  // tips の上書き (リポジトリ配布分 + ローカル編集分)
  try {
    const r = await fetch('data/tips_overrides.json');
    if (r.ok) TIPS_REPO = await r.json();
  } catch {}
  try { TIPS_LOCAL = JSON.parse(localStorage.getItem(LS_TIPSOVR)) || {}; } catch { TIPS_LOCAL = {}; }

  const hashParams = new URLSearchParams(location.hash.slice(1));
  const searchParams = new URLSearchParams(location.search);
  const b = hashParams.get('b');
  const buildFile = searchParams.get('build');
  const editFlag = hashParams.get('edit') === '1' || searchParams.get('edit') === '1';
  const lsFlag = localStorage.getItem(LS_EDITOR) === '1';

  // ライブ同期(?live=<id>)。live.js の準備を最大5秒待つ。
  // 読み込めなかった場合や未設定の場合は、従来機能だけで通常どおり動作する。
  const liveParam = searchParams.get('live');
  if (liveParam) {
    LIVE = await Promise.race([
      window.U2LiveReady || Promise.resolve(null),
      new Promise(r => setTimeout(() => r(null), 5000)),
    ]);
    if (LIVE && LIVE.configured) liveId = liveParam;
    else toast('ライブ同期が未設定のため、通常表示で開きました');
  }

  let loaded = null;
  if (liveId) {
    try {
      const rec = await LIVE.fetchOnce(liveId);
      if (rec && rec.state) { loaded = rec.state; liveLastUpdated = rec.updatedAt || null; }
    } catch (e) { console.error(e); toast('ライブビルドを取得できませんでした'); }
  }
  // ライブがまだ空なら、#b=... や ?build=... の中身から始められるようにする
  // (例: ?live=main&edit=1&build=xxx.json → 既存ビルドを読み込んでから公開)
  if (loaded) {
    // ライブの内容を採用
  } else if (b) {
    try { loaded = await decodeBuild(b); }
    catch (e) { console.error(e); toast('URLのビルドデータを読み込めませんでした'); }
  } else if (buildFile && /^[^\\/]+\.json$/.test(buildFile) && !buildFile.includes('..')) {
    // 日本語ファイル名も許可(パス区切りと .. のみ禁止)。
    // no-cache で毎回サーバーに確認し、builds/ の更新が再読み込みで反映されるようにする
    try { loaded = await (await fetch('builds/' + encodeURIComponent(buildFile), { cache:'no-cache' })).json(); }
    catch (e) { console.error(e); toast(`builds/${buildFile} を読み込めませんでした`); }
  }

  // ライブIDが指定されていれば、中身が空(新規)でも「URL指定のビルド」扱いにする
  const hasUrlBuild = loaded !== null || !!liveId;
  editMode = !hasUrlBuild || editFlag || lsFlag;
  autosaveEnabled = editMode && !hasUrlBuild;

  if (loaded) {
    state = normalizeBuild(loaded);
  } else if (editMode) {
    // 前回の編集内容を復元
    try {
      const saved = localStorage.getItem(LS_AUTOSAVE);
      if (saved) state = normalizeBuild(JSON.parse(saved));
    } catch {}
  }

  bindHeaderButtons();
  renderAll();
  window.addEventListener('resize', drawArrows);

  if (liveId) {
    // ログイン状態が変わったらヘッダーを描き直す
    LIVE.onAuthChange(() => renderHeader());
    // 閲覧者だけ購読する(ホストは自分の編集を上書きされないよう購読しない)
    if (!editMode) startLiveSubscribe();
  }
}

main().catch(e => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend',
    `<div style="padding:20px;color:#ff8a8a;font-weight:700">初期化に失敗しました: ${esc(e.message)}<br>
     ※ data/wagons.json の読み込みには http サーバー経由でのアクセスが必要です(file:// では動きません)。</div>`);
});
