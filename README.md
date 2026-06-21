# ito online helper

Discord通話を前提にした、ito風ゲームのオンライン補助ツールです。

## Firebase設定

`firebase-config.js` の `window.ITO_FIREBASE_CONFIG` をFirebase Web App設定に置き換えると、Firestoreでルーム状態を同期します。

未設定の場合はローカルストレージで動作します。同じブラウザ内での確認用です。
このモードでは、同じ通常ブラウザの複数タブであれば別ユーザとして参加確認できます。
別ブラウザやプライベートブラウザから同じルームには参加できません。

Firestoreには `rooms/{roomId}` の1ドキュメントとしてゲーム状態を保存します。MVPでは認証や厳密なDB読取制御は行いません。
ルームドキュメントはルーム作成時点で作成されるため、ホストの名前登録やゲーム設定の前から共有URLで参加できます。

## ローカル確認

静的ファイルだけで動作します。

```sh
python3 -m http.server 4173
```

その後、`http://localhost:4173` を開きます。
