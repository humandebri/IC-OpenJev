# ModernBERT-Ja-130Mの軽量化とローカルcanister検証

追加学習済み130Mのseed29を固定し、Rustへの移植、INT8変換、専用`ticketing-engine`を実装した。
**当初の厳密な精度維持条件は未達。2026-11-18にユーザーが判定1件の変化を許容し、[本番canisterへの同居準備](TICKETING_COHOST_PREPARATION.md)へ進んだ。** 元の不合格記録は保持する。本番へのdeploy、既存canisterの更新、UIの接続先変更は行っていない。

## 固定したモデルと容量

元の[比較実験](TICKETING_MODEL_COMPARISON.md)のvalidation成績に基づいてseed29を選択した。
test結果や今回の量子化結果によるseedの選び直し、再学習、語彙削減は行っていない。

- source: `sbintuitions/modernbert-ja-130m`、revision `28c180b16463ba6f3fa79b48756fbf21586fe23e`
- checkpoint SHA-256: `1759a2188308275f70bc303646eb288509c74bed11bb1f331d20ad1f469aeaf2`
- 19層、hidden 512、8 heads、vocab 102400、intermediate 2048
- 先頭`<s>`（ID 1）の特徴量を利用。設定の`cls_token_id=6`に置き換えない。
- 部署4クラス・優先度3クラスを共通encoderの1回の実行で判定する。

| 重みの保存形式 | bytes | MiB |
|---|---:|---:|
| 元のPyTorch checkpoint（コンテナ込み） | 528,616,491 | 504.13 |
| FP32参照pack | 528,576,540 | 504.09 |
| INT8 pack | 133,130,268 | 126.96 |

FP32参照packから約74.8%削減。これは重みファイルの削減率であり、heap・stable memory・Wasm・tokenizer込みの削減率ではない。
encoderの行列と埋め込みを、各行の最大絶対値/127をscaleとする対称INT8にする。
scale、正規化、bias、部署・優先度headはFP32のまま保持する。埋め込みだけでFP32の200MiBから約50.4MiBになる。

## 精度と移植の確認

記録は [native.json](../artifacts/ticketing-ja/optimization/native.json)。
日本語・英数字・全半角・改行・絵文字・特殊文字・特殊トークン表記と入力長境界を含め、PythonとRustのtoken IDが一致した。
Rust FP32とPython FP32の最大logit差は`2.193450927734375e-5`。

| 方式 | validation 部署/優先度（各24件） | test 部署（48件） | test 優先度（48件） | test 両方正解 | test 高優先度 |
|---|---|---:|---:|---:|---:|
| Python FP32 | 24 / 24 | 47 | 45 | 44 | 16/16 |
| Rust FP32 | 24 / 24 | 47 | 45 | 44 | 16/16 |
| Rust INT8 | 24 / 24 | 46 | 45 | 43 | 16/16 |

INT8では`test-it-10`の部署がITから総務に変わった。FP32ではITと総務のlogit差が約0.082しかなく、量子化後に順位が逆転した。
優先度は変わっていないが、事前に決めた「validation24件とtest48件の全ラベル一致」には不合格。
テストに合わせたscale調整や特定層の選び直しは実施していない。

記録に含む全入力でのINT8対Python FP32の最大logit差は約0.397、最大確率差は約0.0909。
同じnative CPU経路のtest48件の推論p50はFP32約32.2ms、INT8約40.2msだった。
今回のINT8化をCPUでの高速化と表現しない。以前のMPS GPUや本番APIの応答時間とも直接比較しない。

既存の合成データは回帰確認用であり、実際の企業チケットの精度や未知データへの汎化性能を保証しない。

## 実装とAPI

`crates/ticketing-candle`は日本語モデル専用の固定構成loader、tokenizer、二つの分類head、native JSONL probeを提供する。
共有ModernBERTのencoderは変更していない。共通SIMDのdispatchに512・2048幅を追加し、既存の整数tile処理を130Mにも利用する。FP32 packはnativeの比較用にだけ許可し、canisterは拒否する。
manifestは全tensorの名前・shape・順序・offset・encoding・長さ・SHA-256を検証する。
tokenizerのSHA-256も確認し、paddingと自動truncationを無効にする。

`canisters/ticketing-engine`は既存のopenJevとは別のcanister。
公開queryは合意・認証された結果ではない。

| API | 方式・権限 | 動作 |
|---|---|---|
| `classify(text)` | 匿名可、非replicated query限定 | 部署・優先度のselected、labels、probabilitiesとmodel hash、input_tokens、実測命令数、heap、stable読み出し量を返す |
| `info()` | query | ロード状態、モデル・受信bytes、heap・stable memory使用量を返す |
| `query_limits()` | query | 入力上限、45億命令の測定目標、校正設定の有無を返す |
| `begin_upload(manifest, tokenizer_bytes)` / `upload_chunk(offset, bytes)` | owner update | packとtokenizerを最大1MiBのchunkで順に受信する。同一内容の再送だけ許可する |
| `start_warmup()` / `warmup_next()` | owner update | tokenizerを検証し、tensorごとに検証・ロードする |
| `benchmark(text)` | owner update | 最大128tokensで診断用の命令数を測定する |
| `set_query_limit(tokens)` | owner update | ローカル測定後にquery上限を設定する。精度合格を表す設定ではない |

通常の文字列入力は8192 UTF-8 bytes以下、アーキテクチャ上限は特殊トークン込み128tokens。
空白のみ・空文字・上限超過はエラーで、切り捨てない。
初期状態と新pack投入直後はquery上限未校正で、推論queryを許可しない。

INT8行列はstable memoryに置き、行列演算では最大2MiBの共通読出しbufferを再利用する。
埋め込みは入力中のtokenの行だけを読み、同一推論内の重複tokenを再利用する。
warm-upでは256KiBのbufferで各tensorの完全性を検証し、FP32全重みの展開を避ける。
snapshotにはowner・upload情報を保存し、upgrade後は重みを再アップロードせず再warm-upする。レビュー対応後は古いWasmのquery校正を無効化し、入力上限を再設定する。
stable領域は既存`canister-common`と同様に先頭64MiBをsnapshot用に予約するため、この分も測定値に含む。

## ローカルcanisterの測定

最終記録は [local.json](../artifacts/ticketing-ja/optimization/local.json)。
使い捨てPocketIC 15 application subnetで測定し、終了時にサーバーとcanisterを破棄する。
precision gateが不合格のため、結果の状態は`measured_not_approved`となる。

| 入力tokens | 幅512・2048のSIMD対応前 | 対応後 |
|---:|---:|---:|
| 8 | 1,022,628,347 | 617,504,187 |
| 16 | 1,966,523,868 | 1,083,537,968 |
| 32 | 3,886,347,852 | 2,120,375,876 |
| 64 | 7,853,499,988 | 4,321,555,864 |
| 128 | 16,285,155,597 | 9,221,267,245 |

表は同じ`x `の繰り返し入力に対するowner診断updateの命令数。32tokensで約45.4%削減した。
queryを想定した45億命令の目標では、対応前の境界は36tokens、対応後は65tokens。
tileの端数処理によりコストが単調増加しないので、最終版は3tokensから上限付近まで全長を順に測り、最初に45億を超えた長さの手前を上限にした。
この入力上限は測定した文字列群に基づくローカルの設定であり、任意の入力や本番replicaでの上限を保証しない。

ロード後のheapは101,777,408 bytes（97.06MiB）、stable memoryは207,028,224 bytes（197.44MiB）。
stableの内訳にはINT8重み、tokenizer 6,724,873 bytes、予約領域64MiB、ページ境界の余白が含まれる。
生成Wasmは4,843,356 bytes（約4.62MiB）。

validation24件とtest48件の全72件をqueryで処理し、native INT8と全ラベルが一致した。
最大確率差は約0.00117。FP32の誤差閾値をINT8の一致条件として扱わず、既存のINT8 golden検証と同様に確率差を別途報告する。
初期の`1e-4`による比較で失敗した試行も`local-parity-diagnostic.json`と`local-optimized.json`に保持している。
独立したWasmカーネル試験は14,760ケースでi64参照計算と出力bitが一致した（[記録](../artifacts/ticketing-ja/optimization/wasm-kernels.json)）。
既存幅768・1152の検証も含む。

未ロード時・空入力・長さ上限超過・不正manifest・不完全upload・offset飛び・管理APIの権限違反を確認した。
upgradeでowner・model hash・受信済み重み・入力上限が保持され、再warm-up後の確率がupgrade前とbit単位で一致した。
反復queryの測定前にはowner updateでcanister versionを進め、query結果キャッシュを無効にする。

初回の起動失敗、対応前の計測、数値比較の診断、queryキャッシュを含む中間試行も同じディレクトリに保持する。
`local.json`を最終記録とし、中間試行の短い応答時間を推論速度として用いない。

## 再現手順

前回の追加学習済みcheckpoint、固定revisionのHFキャッシュ、専用Python環境が必要。
依存は既存の`tools/requirements-ticketing-models.lock.txt`を使う。モデルやpackはGitには含めない。

```sh
# 出力先が存在すると失敗する。既存モデルを上書きしない。
.venv/ticketing-comparison/bin/python tools/optimize_ticketing_model.py prepare
cargo build --release --locked --offline -p ticketing-candle --bin ticketing-infer
.venv/ticketing-comparison/bin/python tools/optimize_ticketing_model.py validate
# 現在は精度ゲート不合格のため、native.jsonを残してexit 2となる。

bash tools/build_one.sh ticketing-engine
cargo test --locked --offline -p ticketing-candle -p modernbert-candle --lib
cargo clippy --locked --offline -p ticketing-candle -p ticketing-engine --all-targets -- -D warnings
cargo build --release --locked --offline --target wasm32-unknown-unknown \
  -p verdict-simd --example wasm-check
node tools/check_verdict_simd_wasm.mjs

# 本番への接続や既存canister IDは受け付けず、使い捨てPocketIC上でだけ実行する。
# 不合格モデルの性能を測る場合に限って診断フラグを明示する。
POCKET_IC_BIN=/path/to/pocket-ic-15 \
TICKETING_ALLOW_REJECTED=1 \
cargo test --release --locked --offline -p ticketing-engine \
  --test local_optimization -- --ignored --nocapture
```

再実行時のnativeレポートは`--report <未使用のパス>`、localレポートは`TICKETING_OUT=<未使用のパス>`で保存先を変えられる。
localテストの比較元は既定の`native.json`と既定packに固定しており、別条件の実験はそれらを明示的に整えた別checkoutで実施する。
検証に失敗した試行も削除せず記録する。

命令数の基準は[ICP公式のresource limits](https://docs.internetcomputer.org/references/resource-limits/)のquery 50億、update 400億。
ローカル測定はtokenizerと推論を含むが、Candid引数デコード・応答エンコードを含まないため、queryの目標を45億に抑える。
PocketICの応答時間は本番APIのレイテンシーを表さない。
