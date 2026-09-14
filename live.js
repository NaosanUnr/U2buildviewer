/* =========================================================
 * ライブ同期 (Firebase Realtime Database)
 * ---------------------------------------------------------
 * ホストがビルドを公開すると、閲覧者の画面が即座に更新される仕組み。
 * このファイルだけが Firebase を直接触り、app.js からは
 * window.U2Live 経由で使う(app.js は従来どおりのスクリプトのまま)。
 *
 * データの置き場所:
 *   /builds/{buildId} = { state: {...ビルド本体...}, updatedAt: <サーバー時刻> }
 *
 * 権限:
 *   読み取り … 誰でも可(閲覧者はログイン不要)
 *   書き込み … ホストのアカウントのみ(Realtime Database のルールで制限)
 * ========================================================= */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import { getDatabase, ref, onValue, get, set, serverTimestamp }
  from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-database.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, setPersistence, browserLocalPersistence }
  from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';

const cfg = window.U2_FIREBASE_CONFIG || {};
// apiKey と databaseURL が両方揃っている時だけライブ機能を有効にする
let configured = !!(cfg.apiKey && cfg.databaseURL);

let db = null, auth = null;
let currentUser = null;
const authCallbacks = [];

if (configured) {
  try {
    const app = initializeApp(cfg);
    db = getDatabase(app);
    auth = getAuth(app);
    // ログイン状態をブラウザに保持(閉じても次回ログイン不要)
    setPersistence(auth, browserLocalPersistence).catch(() => {});
    onAuthStateChanged(auth, u => {
      currentUser = u;
      authCallbacks.forEach(cb => { try { cb(u); } catch (e) { console.error(e); } });
    });
  } catch (e) {
    console.error('Firebase の初期化に失敗しました', e);
    configured = false;
  }
}

const api = {
  configured,

  /* --- 認証(ホストのみ) --- */
  user: () => currentUser,
  onAuthChange(cb){ authCallbacks.push(cb); cb(currentUser); },
  async signIn(email, password){
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user;
  },
  async signOut(){ await signOut(auth); },

  /* --- ビルドの読み書き --- */
  // 現在の内容を1回だけ取得(初期表示用)
  async fetchOnce(buildId){
    const snap = await get(ref(db, 'builds/' + buildId));
    return snap.exists() ? snap.val() : null;
  },
  // 変更を購読。返り値を呼ぶと購読解除
  subscribe(buildId, cb){
    return onValue(ref(db, 'builds/' + buildId), snap => {
      cb(snap.exists() ? snap.val() : null);
    }, err => {
      console.error('ライブ購読エラー', err);
    });
  },
  // ホストがビルドを公開(上書き)
  async publish(buildId, state){
    await set(ref(db, 'builds/' + buildId), {
      state,
      updatedAt: serverTimestamp(),
    });
  },
};

window.U2Live = api;
// app.js 側で待っている準備完了の合図
if (typeof window.__u2LiveResolve === 'function') window.__u2LiveResolve(api);
