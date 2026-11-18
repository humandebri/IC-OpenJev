# ModernBERT-Ja 70M / 130M 日本語チケット分類の比較

実施日：2026-11-18（日本時間）。同一の合成データ、学習条件、3種類のseedで追加学習して比較しました。今回の条件では130M版の方が高精度でした。ICPへの移植・配備や既存UIのモデル変更は行っていません。

同じ48件で現在のopenJevも測定した結果は [現行モデルと130Mの比較](TICKETING_CURRENT_VS_130M.md) を参照してください。公開APIの入力制限による未回答と、ローカルで全件を処理した分類精度を分けています。

## 主な結果

以下は新しいテスト48件に対する3回の平均です。同じ48件を繰り返しており、144件の独立データではありません。

| 指標 | 70M | 130M |
| --- | ---: | ---: |
| 担当部署の正解率 | 88.2% | 94.4% |
| 優先度の正解率 | 79.9% | 91.0% |
| 部署・優先度が両方正解 | 69.4% | 86.1% |
| 部署のmacro-F1 | 0.880 | 0.945 |
| 優先度のmacro-F1 | 0.788 | 0.907 |
| 高優先度の見落とし（seed別、各16件） | 0 / 2 / 1 | 0 / 0 / 0 |
| batch=1 推論時間の中央値の平均 | 6.6 ms | 9.3 ms |
| FP32チェックポイント容量 | 267.1 MiB | 504.1 MiB |
| 実測パラメータ数（分類ヘッド込み） | 70,005,511 | 132,144,135 |

推論時間はMac mini / Apple M6 / メモリ32GBのMPS（GPU）、FP32で測定しました。tokenize・デバイス転送・forward・softmaxを含み、モデル読み込みは含みません。各runで5回warm-up後、同じ48文をbatch=1で測定しています。ICPの応答時間・命令数・INT8容量を示すものではありません。

## seedごとの結果

| モデル | seed | 選択epoch | 部署正解 / 48 | 優先度正解 / 48 | 両方正解 / 48 | 高優先度検出 / 16 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| modernbert-ja-70m | 17 | 5 | 40 | 36 | 28 | 16 |
| modernbert-ja-70m | 29 | 8 | 45 | 41 | 39 | 14 |
| modernbert-ja-70m | 43 | 7 | 42 | 38 | 33 | 15 |
| modernbert-ja-130m | 17 | 5 | 45 | 45 | 42 | 16 |
| modernbert-ja-130m | 29 | 5 | 47 | 45 | 44 | 16 |
| modernbert-ja-130m | 43 | 4 | 44 | 41 | 38 | 16 |

## 比較条件

- 公式モデル：[70M](https://huggingface.co/sbintuitions/modernbert-ja-70m)、[130M](https://huggingface.co/sbintuitions/modernbert-ja-130m)。取得時に両方のrevisionを固定しました。
- データ：学習132件（手作りテンプレート120件＋以前の調整用12件）、検証24件、テスト48件。すべて架空の日本語です。ID・本文の重複とラベル分布を事前検査しました。
- 以前の評価用24件は、学習・検証・今回のテストに使っていません。新しいテスト48件はcheckpoint選択や設定調整には使っていません。
- 初頭トークン `<s>` の表現に部署4クラス・優先度3クラスの線形ヘッドを追加し、encoder全体も含めて学習しました。元のMaskedLMヘッドは使用していません。
- 8epochs、batch=16、encoder学習率3e-5、head学習率1e-3、weight decay 0.01、gradient clip 1.0、FP32、eager attention。seedは17 / 29 / 43です。
- checkpointは検証データの部署・優先度の平均正解率が最大のepochを選び、同点なら検証lossが小さいものを選択しました。テストを見た再学習はしていません。
- 入力上限128 tokensを固定し、切り詰めはしていません。両モデルとも実際の最大長は学習22 / 検証17 / テスト18 tokensでした。
- 部署の割り当てと優先度の定義は入力ファイルに記載しています。部署・優先度のcross-entropyを同じ重みで学習しています。

## 解釈と限界

この条件では130M版が有望です。部署・優先度ともに全3seedで70M版より正解数が多く、今回の高優先度16件は全3回で検出しました。一方、両方を正しく分類できた割合は平均86.1%で、通常の問い合わせを高優先度にする誤りなどが残っています。

これは日本語モデルを用途別に追加学習した小規模な予備比較です。ゼロショットの性能、日本語一般の能力、実企業の問い合わせへの性能を証明するものではありません。データは同じ作成者が用意した合成例で、学習文には定型表現があり、優先度も未来の予定・当日期限などを明示した分かりやすい例が中心です。実データの曖昧さ、部署間の責任分担、誤字、長文、複数要件、判断保留は未検証です。

元のopenJevの8/24件・9/24件とは、モデルだけでなく追加学習の有無とテストデータが異なります。今回の数値から同一条件で何ポイント改善したとは言えません。元の公開保留判断は変更していません。

ICPで使うには、別途tokenizer・モデル構造・分類ヘッドの対応、量子化による精度差、命令数・メモリ・実行時間を検証する必要があります。今回のチェックポイントを既存canisterへそのまま投入することはできません。

## 再現と記録

入力：[固定データ](../fixtures/ticketing-ja/comparison/cases.json)。全epochの検証値、全テスト予測、source revision・ファイルハッシュ、学習時間、レイテンシは[実行記録](../artifacts/ticketing-ja/model-comparison/20261118T012521Z-bc177d61/report.json)に保存しました。モデルファイルと学習済みcheckpointはGit対象外の `models/ticketing-ja/` に保存しています。

```sh
uv venv .venv/ticketing-comparison --python 3.11
uv pip install --python .venv/ticketing-comparison/bin/python -r tools/requirements-ticketing-models.lock.txt
.venv/ticketing-comparison/bin/python tools/compare_ticketing_models.py --device mps
# GPUがない場合は --device cpu。ただし速度は本結果と比較できません。
python3 -m unittest discover -s tests -p "test_ticketing_model_comparison.py" -v
```

新しい実行は時刻＋UUIDの別ディレクトリに保存します。現在の再実行コマンドは公式配布先のrevisionを実行開始時に固定して記録します。完全に同じweightsで再現する場合は実行記録のrevisionと照合してください。MPS上の学習のビット単位の一致は保証しません。

最初の準備実行はSentencePiece/protobufの不足で学習前に失敗しました。依存関係を補った後、別runとして最初から実行し直しており、失敗記録も保持しています。
