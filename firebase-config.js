/* =========================================================
 * Firebase 接続設定
 * ---------------------------------------------------------
 * Firebaseコンソールの「プロジェクトの設定 → マイアプリ → ウェブ」で
 * 表示される firebaseConfig の中身を、そのまま下に貼り付けてください。
 *
 * ここに書く値は「公開される前提」の情報です。
 * GitHubのパブリックリポジトリにpushしても問題ありません。
 * 実際の防御は Realtime Database の「ルール」側で行っています。
 *
 * ※ ログイン用のパスワードは絶対にここへ書かないでください。
 *   (パスワードはアプリ上のログイン画面で毎回入力する形です)
 *
 * 空のままなら、ライブ同期機能はオフになり、
 * 従来どおり #b=... と ?build=... だけが動きます。
 * ========================================================= */
window.U2_FIREBASE_CONFIG = {
  apiKey: "AIzaSyBpO0sHVhaWHJ_KR8J4Qb36s50Ap73DYMk",
  authDomain: "u2buildviewer.firebaseapp.com",
  databaseURL: "https://u2buildviewer-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "u2buildviewer",
  storageBucket: "u2buildviewer.firebasestorage.app",
  messagingSenderId: "906984258850",
  appId: "1:906984258850:web:5f39a6e9d6cbc81b4cb97b",
  measurementId: "G-RBE3W1TT03"
};
