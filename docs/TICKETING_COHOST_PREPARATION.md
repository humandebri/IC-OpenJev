# 本番openJevへの130M同居：準備と配備手順

対象は`qojfj-6qaaa-aaaam-qjkaq-cai`。既存151MモデルとAPIを残し、追加学習済みModernBERT-Ja-130Mを同じcanisterに追加する。
**この作業は準備とローカル検証まで。本番のupgrade・upload、UIの接続先変更は実行していない。**

INT8による部署判定1件の変化（47/48→46/48）は、2026-11-18のユーザー指示「精度は問題ない範囲です」により許容された。
元の厳密一致ゲートの`rejected`記録は保持し、このpackに対する採用判断を`artifacts/ticketing-ja/cohost/precision-acceptance.json`（ローカル生成物）に別途記録する。

## 準備物と確認結果

配備用bundleは`build/ticketing-cohost-prep-20261118-r2/`。旧`ticketing-cohost-prep-20261118/`はレビュー前の記録として保持し、配備には使わない。
形式バージョン2では、コピーしたWasm・CLI・重みを検証記録と照合してから、完成したディレクトリをatomic renameで公開する。
並行ビルドで元ファイルが変わっても、未検証のコピーは公開しない。`--check`もreadiness・検証記録・実ファイルの一致を確認し、旧形式は再生成を要求する。

| ファイル | 用途 |
|---|---|
| `verdict-engine.wasm` / `.did` | 二つのモデルを扱う候補WasmとCandid |
| `production-reference.wasm` | 読み取り確認時の本番module hashと一致するrollback用Wasm |
| `mainnet-before-status.json` / `.did` | 配備前条件とAPI互換性の比較元 |
| `ticketing-pack/` | 130MのINT8重み、tokenizer、manifest |
| `tools/verdict-upload` | 既存151Mの再warm-upに使うCLI |
| `tools/ticketing-upload` | 日本語モデル専用CLI。既定はオフライン検査 |
| `verification/` | native精度比較、実モデル同居・署名付きHTTP upload・rollback検証 |
| `readiness.json` / `manifest.json` / `SHA256SUMS` | 判断状態とファイル整合性 |

記録のある本番module hashは`186527a9e07f600169502a3fae0304ac185857d31ccf44e686b764500fecfb5d`。
候補Wasmのhashはbundleの`readiness.json`と`artifacts/ticketing-ja/cohost/local.json`（ローカル生成物）を参照する。
`didc check`で本番Candidに対する後方互換性を確認する。

使い捨てPocketIC 15のapplication subnet上で、本番と同じWasm・151M packから次を確認した。

- upgrade後も既存モデルのhash、52tokensのquery上限、caller、64件のschema、料金設定が保持される。
- 既存の`decide_query`のlogitと確率が変わらない。52tokens・25候補のraw queryも上限内で同じlogitを返す。
- 130Mを1MiB uploadした時点でupgradeし、署名付きHTTPの実CLIで残りを再開できる。
- 日本語モデルのupload・warm-upは、既にwarmな既存モデルを解除しない。保存領域に重なる既存モデルのuploadは、変更前に拒否する。
- 130Mのvalidation24件・test48件の全72件をqueryで処理し、native INT8と選択ラベルが一致する。
- 本番と同じ旧Wasmへrollbackし、候補Wasmへ戻しても両方の重みを再uploadせず復元できる。
- rollback中の旧Wasmから日本語領域の先頭64KiBを実際に上書きした場合も、再upgradeが成功する。日本語モデルは解除され、旧モデルの復旧と日本語モデルの再upload後に同じ結果を得られる。
- 日本語モデルのquery校正はupgradeごとに無効化され、再warm-upだけではqueryを再開しない。

二つのモデルをロードしたheapは約183MiB。日本語モデルのローカルquery上限は特殊トークン込み65tokens。
これは今回の候補Wasm・入力群の測定値で、配備時にはCLIが改めて実測して上限を設定する。
ローカルのwall-clock時間は本番レイテンシーとして扱わない。

## APIと保存領域

既存の`info`・`query_limits`・`decide_query`等は引き続き151Mモデルを指す。
日本語モデルには別のメソッド名を使い、モデル選択を曖昧にしない。

| API | 権限・用途 |
|---|---|
| `classify_ticket(text)` | 匿名query。部署・優先度のラベルと確率をまとめて返す |
| `ticketing_info()` / `ticketing_query_limits()` / `ticketing_storage()` | query。日本語モデルの状態・入力上限・領域を確認する |
| `ticketing_begin_upload` / `ticketing_upload_chunk` | 既存owner専用update。最大1MiBのchunkで受信・再開する |
| `ticketing_start_warmup` / `ticketing_warmup_next` | owner専用update。tokenizerとtensorを検証する |
| `ticketing_benchmark` / `ticketing_set_query_limit` | owner専用update。命令数を測定してqueryを有効にする |
| `ticketing_clear_model` | owner専用update。日本語モデルを解除する。既存モデルには触れない |

旧v4 snapshotと既存モデルの64MiB以降の保存位置は維持する。
日本語モデルの管理情報は、未使用だったheader 32..48 bytesと64KiB..960KiBの二つのslotにversion・checksum付きで保存する。
旧Wasmはこの領域を読まないため、旧snapshot形式への変換操作なしでrollbackできる。
rollback中の旧Wasmは日本語用領域を保護しない。旧モデルのupload予定サイズがその領域に重なる場合、新版への復元時に旧モデル・途中uploadを優先し、日本語モデルの管理情報と校正を解除する。
この場合は旧モデルのuploadを完了またはやり直してから、日本語モデルを再uploadする。重なる可能性がある古い日本語モデルは推論に使わない。

日本語の重み領域は、既存packとtokenizerの末尾に16MiBの余裕を加え、64KiB境界に揃えて配置する。
今回の既存packでは日本語モデルの開始位置は239,730,688 bytes、両packのupload後のstable memoryは379,650,048 bytes（362.06MiB）。
固定256MiBの既存モデル枠を予約する初期案に比べ、約91.4MiBの割当を削減した。
`ticketing_storage.reserved=true`の間、既存モデルの再uploadがこの境界を越える場合は`Capacity`で拒否する。
より大きな既存モデルへ変更する際は、日本語モデルを解除してから既存モデルを更新し、日本語モデルを新しい末尾へ再uploadする。
stable memoryの割当はrollbackやモデル解除では縮まらない。

## 配備する際の手順（この準備作業では未実行）

配備の明示的な依頼を受けてから、以下を実行する。`COHOST_OWNER_PEM`は運用者が既に管理しているEd25519 owner鍵のパスで、bundleには運用秘密鍵を含めない。検証ソースの鍵は公開fixtureで、本番identityではない。

```sh
COHOST_BUNDLE="$PWD/build/ticketing-cohost-prep-20261118-r2"
COHOST_CANISTER=qojfj-6qaaa-aaaam-qjkaq-cai
COHOST_OWNER_PEM=/secure/path/to/owner.pem

python3 tools/prepare_ticketing_cohost.py --check --out "$COHOST_BUNDLE"
icp canister status "$COHOST_CANISTER" -n ic --identity production --json
icp canister call "$COHOST_CANISTER" info '()' --query -n ic \
  --identity anonymous --candid "$COHOST_BUNDLE/mainnet-before.did"
```

module hashが`readiness.json.expected_module`、モデルhashが`readiness.json.legacy_model`と一致し、controller・残高・freeze条件を確認してから進める。
本番が変わっていた場合は、古いbundleをそのまま適用せず比較元を取り直して検証する。

今回の読み取りでは、caller登録数0の状態で`production` identityの空token queryが`Unauthorized`ではなく`TooLong`になり、owner権限を確認した。
公開Principalは`production-principal.txt`に保存した。配備前に以下で鍵のPrincipalも照合する。

```sh
"$COHOST_BUNDLE/tools/verdict-upload" \
  --url https://icp-api.io --canister "$COHOST_CANISTER" \
  --pem "$COHOST_OWNER_PEM" --print-principal
```

upgradeにより既存モデルのheapキャッシュは失われる。既存APIは再warm-up完了まで`ModelUnavailable`等を返すため、最初のupgrade・151M再warm-upは保守時間に行う。
warm-upは複数のupdateを順に実行するので、本番では数分かかる可能性がある。
151Mが再びwarmになってから日本語モデルをuploadする。

```sh
icp canister install "$COHOST_CANISTER" -n ic --identity production \
  --mode upgrade --wasm "$COHOST_BUNDLE/verdict-engine.wasm" --args '()'

"$COHOST_BUNDLE/tools/verdict-upload" \
  --url https://icp-api.io --canister "$COHOST_CANISTER" \
  --pem "$COHOST_OWNER_PEM" --warm-only \
  --cls 50281 --sep 50282 --mask 50284 --pad 50283

"$COHOST_BUNDLE/tools/ticketing-upload" \
  --pack "$COHOST_BUNDLE/ticketing-pack" \
  --url https://icp-api.io --canister "$COHOST_CANISTER" \
  --pem "$COHOST_OWNER_PEM" \
  --expected-legacy-model 0757d774c8c44397d189c5b479853897acef8f1e2b55ebf1f5a46969063225e0 \
  --upload --max-tokens 65 --accept-label-drift
```

CLIは既存モデルが期待したhashでwarmであることを前後に確認する。
tokenizer・全tensorのhashをオフライン検査した後で、日本語モデルだけをuploadする。
校正は3tokensから順にowner updateで測定し、45億命令以内の長さをquery上限にする。
途中で通信が切れた場合は同じコマンドに`--resume`を追加する。異なるpackへの再開は拒否する。
後日のupgrade後に日本語モデルを戻す場合は、`--upload`を`--warm-only`に変更して再warm-up・再校正する。

```sh
icp canister call "$COHOST_CANISTER" ticketing_info '()' --query -n ic \
  --identity anonymous --candid "$COHOST_BUNDLE/verdict-engine.did"
icp canister call "$COHOST_CANISTER" ticketing_query_limits '()' --query -n ic \
  --identity anonymous --candid "$COHOST_BUNDLE/verdict-engine.did"
icp canister call "$COHOST_CANISTER" classify_ticket '("接続できません")' --query -n ic \
  --identity anonymous --candid "$COHOST_BUNDLE/verdict-engine.did"
```

既存の`info`・`query_limits`・`decide_query`も確認し、旧モデルのhash・52tokensの上限・返答を維持していることを確認する。
日本語チケットUIから130Mを使う際は`classify_ticket`へ接続する。現在のUIは既存`decide_query`を使用している。

旧版へ戻す場合は、`production-reference.wasm`を`--mode upgrade --args '()'`で入れ、同じ151Mの`--warm-only`を実行する。
旧API・旧モデルへ戻す操作であり、日本語モデル用stable領域の割当や保存済みデータを巻き戻す操作ではない。

## 準備を再生成する場合

同じPython環境と固定checkpoint/HFキャッシュ、両方のpack、PocketIC 15を使う。

```sh
cargo build --release --locked --offline -p ticketing-candle --bin ticketing-infer
.venv/ticketing-comparison/bin/python tools/optimize_ticketing_model.py validate \
  --report artifacts/ticketing-ja/cohost/native.json
# 元の厳密一致条件によるexit 2は記録する。採用判断はprecision-acceptance.jsonで別に管理する。
bash tools/build_one.sh verdict-engine
cargo build --release --locked --offline -p verdict-upload --bins
POCKET_IC_BIN=/path/to/pocket-ic-15 \
cargo test --release --locked --offline -p verdict-engine --test ticketing_cohost \
  cohost_upgrade_and_rollback -- --ignored --nocapture
python3 tools/prepare_ticketing_cohost.py \
  --inputs build/ticketing-cohost-inputs-20261118-r2
python3 tools/prepare_ticketing_cohost.py --check
```

検証JSONとbundleは上書きを拒否する。再実行では`--report`と`COHOST_OUT`で新しい記録先を指定し、最終採用する記録を明示的に揃えてから、`--out`で未使用の配備先ディレクトリを指定する。
本番のstatus・Candid・一致する旧Wasmは事前に取得し、`--inputs`で入力ディレクトリを指定する。出力先は作成済みディレクトリと兼用しない。
作成済みbundleの検査は`--check --out <bundle>`で行える。
