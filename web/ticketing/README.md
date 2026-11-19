# openJev Japanese ticketing demo

作業ツリーの既定画面は、IT問い合わせの対応キューと優先度を提案するデモです。
現時点では全件を担当者確認に回します。ローカル実行・評価結果・新APIは
[ITキュー分類の説明](../../docs/IT_TICKET_ROUTING.md) を参照してください。
`?local=1` はローカル推論、`?view=department` は既存の部署分類画面です。
2026-11-19に本番canisterと `https://ticketing.kinic.xyz` へ配備しました。
公開サイトの既定画面もITキュー分類です。既存の部署分類は `?view=department` から利用できます。

部署分類画面は本番canisterの日本語130Mモデルを、匿名の `classify_ticket` queryで呼び出します。
問い合わせ1件につき推論は1回で、部署と優先度の両方を表示します。
候補スコアは校正済みの正答率ではありません。架空の内容だけを入力してください。

## 配備

公開先は `https://ticketing.kinic.xyz`。既存のゲーム `openjev.kinic.xyz` とは別の
assets-only Worker `openjev-ticketing` に配備します。秘密鍵やAPIキーは使いません。
`deploy.config.json` が配備先のアカウント・Worker・ドメインを定義します。

Node.js 24、pnpm 11.25.0、認証済みのCloudflare cf CLI 1.0.0-beta.2を使用します。
`kinic-production` プロファイルが `kinic.xyz` のアカウントに接続していることを確認してください。

```sh
cd web/ticketing
pnpm test
pnpm run build:deploy
pnpm run deploy:check
# 明示的に公開する。初回は新規Workerとカスタムドメインを作成する。
pnpm run deploy
```

`build:deploy` はViteの `dist/` からcfのBuild Output Specification v0を
`.cloudflare/output/v0/` に作成します。準備とdry-runはローカル操作です。
`deploy` はその準備済みのファイルだけをアップロードします。
公開後はHTTPS、モデル接続、架空の問い合わせによる部署・優先度表示を確認します。
更新を戻す場合はCloudflare Workersの配備履歴から直前のバージョンを再配備します。

## 公開画面

- 日本語モデルの稼働状況、モデル識別子、実際の入力トークン上限を表示します。
- 入力変更時は古い結果を破棄し、通信失敗時は再試行できます。
- モデル変更時には再接続し、異なるモデルの結果を混在させません。
- 旧 `decide_query` モデルの固定評価は公開画面に混ぜず、ローカルの計測JSONもビルドに取り込みません。
- ブラウザーの永続保存領域への入力保存、認証、update呼び出しはありません。

## 旧モデルの検証ツール

以下の `src/model.ts`、`study:*` と検証条件は、旧 `decide_query` モデルの調査用に保持しています。
部署分類画面は `src/ticketing-model.ts` から日本語専用APIを使用します。
旧モデルの初回評価は部署8/24件、優先度9/24件で不合格でした。
[旧評価](../../docs/TICKETING_DEMO_JA.md) と [日本語モデルの比較](../../docs/TICKETING_MODEL_COMPARISON.md) は別の記録です。

## 構成

- `src/model.ts`：公開推論APIとの接続・応答検証。
- `src/study-core.ts`：入力・調整結果の検証、合否判定、実行と結果保存。模擬クライアントを使ったオフラインテストが可能です。
- `scripts/study.ts`：CLI。入力とコード・依存関係のハッシュを取得します。
- [fixtures/ticketing-ja/cases.json](../../fixtures/ticketing-ja/cases.json)：調整用12件・評価用24件の架空の問い合わせ。
- `artifacts/ticketing-ja/runs/<UTC時刻＋UUID>/report.json`：形式バージョン2の実行記録。既存の4件のJSONは元の位置に残します。

## ローカルの確認とCI

Node.js 24とpnpm 11.25.0を使用します。Nodeの対応範囲は `package.json` の `engines` に記載しています。pnpm設定とロックファイルを維持し、依存関係の更新は今回行っていません。

```sh
cd web/ticketing
pnpm install --frozen-lockfile
pnpm run test
pnpm run typecheck
```

上記のテストは模擬クライアントと一時ディレクトリを使用し、本番APIには接続しません。CIのticketing専用ジョブも同じ確認だけを行います。

## 本番APIを使う検証

以下はインターネット接続を要し、本番の匿名queryを使います。update、モデル設定変更、配備は行いません。固定した架空の問い合わせだけを送信し、queryの応答を合意・認証された判断記録としては扱いません。

```sh
# web/ticketing 内から実行。24回の推論を行い、新しいreport.jsonの絶対パスを表示します。
pnpm run study:dev

# 表示された調整結果のパスを明示指定。相対パスは現在のディレクトリを基準に解釈します。
# 次の <development-run-id> を、直前に作成された実行IDに置き換えてください。
pnpm run study:evaluate --development '../../artifacts/ticketing-ja/runs/<development-run-id>/report.json'
```

評価では48回の推論を行います。最新の調整結果を自動選択する機能はありません。旧形式の `artifacts/ticketing-ja/development.json` などは過去の証拠として保持し、新しい評価の入力には使えません。`study:dev` で形式バージョン2の記録を作成してください。

## 固定条件と合否判定

- 入力の件数、分類の許容値、空でないID・本文、全体でのID・本文の重複なしを接続前に検証します。評価用は4部署×3優先度×2件で固定です。
- 給与計算・社会保険は人事、経費・請求・送金・納税は経理に割り当てます。優先度は、将来の計画相談を低、通常の問い合わせを通常、当日期限の処理不能や目前の全社業務停止を高とします。
- 調整用だけで候補表現を選び、評価前に固定します。指定した調整結果が正常完了していて、入力・推論と評価のコード・package設定とlockfileのハッシュが一致することを必須とします。
- 本番モデル識別子が調整時と一致しなければ、評価の推論を開始しません。実行中の各応答でもモデル一致を検査します。
- 全48判定が成功し、部署と優先度それぞれ20/24件以上正解、高優先度8件の見落としゼロが公開条件です。単に`correct`フラグや判定件数だけを信用せず、各ケースID・タスク・実際の選択を照合します。
- 終了コードは、正常な調整の完了・評価合格が0、準備や実行の異常が1、完了した評価の不合格が2です。通信失敗・応答不正があった実行は異常として扱います。

## 記録の保存

実行ごとに時刻とUUIDで新しいフォルダを排他的に作成します。`report.json` は一時ファイルから置換し、進行中は `state=running`、終了時は `completed` または `failed` を記録します。強制終了した場合は `running` の途中結果が残ることがありますが、評価の調整結果には使えません。完了済み結果の上書きや中断した実行の自動再開は行いません。

記録にはモデル識別子、稼働状態、入力上限、候補表現、入力・コード・依存関係のハッシュ、全判定、トークン数、所要時間、エラー、集計、評価で参照した調整結果のパスとSHA-256を含めます。問い合わせ本文と期待値はfixtureのIDで照合できます。実行時刻・応答時間は再実行で変わります。

旧モデルの検証ツールでは英訳・学習・モデル交換を行いません。候補スコアは校正済み正答率ではなく、合成された小規模なデータの結果が企業の実データにおける精度を保証するものでもありません。精度改善のために旧評価データを調整に利用する場合は、別の新しい評価用データを用意してください。

実験の生データ `artifacts/ticketing-ja/` は Git 管理外で、公開ビルドには含めません。clone 直後もテストとビルドを実行できます。テストでは実測値を含まない合成の選択結果を使います。比較結果の要約は `docs/TICKETING_*.md` を参照してください。
