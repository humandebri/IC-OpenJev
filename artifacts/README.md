# 検証記録の管理

ソース、再生成スクリプト、小さな検証記録、集計結果はGitで管理します。
大きな測定JSONの盤面・手番・工程ごとの全履歴はローカルに保持し、
`.gitignore`の明示的なパス指定でGitから除外します。既存の追跡済み記録は変更しません。

対象は[summary-sources.json](summary-sources.json)に列挙しています。
[summaries/](summaries/)には実行条件、集計値、ゲーム単位の結果、元ファイルのSHA-256とサイズ、
省略した項目の位置・件数・ハッシュを保存します。要約にない詳細を検証するには生データが必要です。
ハッシュだけでは元データを復元できません。今回の整理では元ファイルを削除していません。

```sh
python3 tools/summarize_artifacts.py --write
python3 tools/summarize_artifacts.py --check
python3 tools/manifest.py --write
python3 tools/manifest.py --check
```

新しいcloneでは生データはありません。`--check`はその件数を明示し、存在する生データのみ照合します。
生データを作り直す方法は[Tetris入力調査](../docs/TETRIS_INPUT_STUDY.md)、
[query計測](../docs/QUERY_PROFILE.md)、各Tetris文書を参照してください。
入力調査の`fixtures.json`・`development.json`も生成物です。query調査の前に文書記載のnative調査を実行してください。
実測の時刻・応答時間などは変わるため、再実行で過去のハッシュが一致するとは限りません。

新たな大容量記録は自動的には除外しません。必要性を確認して対象一覧と`.gitignore`を更新し、
要約を生成します。生データを共有する場合は別の保管先を用意してください。

日本語チケット検証の新しい記録は `ticketing-ja/runs/<UTC時刻＋UUID>/report.json` に実行ごとに保存します。
既存の `ticketing-ja/` 直下の4件のJSONは初回検証の証拠として保持し、上書き・移動しません。
形式バージョンや実行方法は [チケット検証のREADME](../web/ticketing/README.md) を参照してください。

130Mの軽量化記録は `ticketing-ja/optimization/` に保存します。`native.json`はPython FP32・Rust FP32・INT8の比較と精度ゲート、`local.json`は使い捨てPocketICでの計測とupgrade検証です。精度不合格でも診断計測を残し、実行検証の成否と採用可否を区別します。[再現手順と結果](../docs/TICKETING_130M_OPTIMIZATION.md)を参照してください。

本番canisterへの同居準備は `ticketing-ja/cohost/` に記録します。`precision-acceptance.json`は特定packへのユーザーの精度許容判断、`local.json`は本番と同じWasmからのupgrade、実CLIによるローカルHTTP upload、rollback検証です。[配備準備と手順](../docs/TICKETING_COHOST_PREPARATION.md)を参照してください。

`local-before-review-r2.json`は復旧経路修正前の記録として保持します。現行`local.json`にはrollback中に旧Wasmから日本語領域を上書きした後の再upgrade・両モデルの復旧も含めます。

`ticketing-ja/` の実測JSON・学習履歴・ローカル検証記録は Git 管理外です。以下のパスへの参照はローカルで生成した記録を指します。比較結果の要約と再現手順は `docs/TICKETING_*.md` に残しています。
