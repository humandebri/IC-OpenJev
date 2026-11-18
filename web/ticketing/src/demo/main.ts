import './style.css';
import corpus from '../../../../fixtures/ticketing-ja/cases.json';
import corpusSource from '../../../../fixtures/ticketing-ja/cases.json?raw';
import type { Row } from './results';

// Local measurements are optional and deliberately excluded from Git.
type Evaluation = { corpus_sha256: string; rows: Row[]; started_at: string; status: { model: number[] } };
const evaluation = Object.values(import.meta.glob<Evaluation>(
  '../../../../artifacts/ticketing-ja/evaluation.json', { eager: true, import: 'default' },
))[0];
import { CANISTER, connect, tasks, ModelChangedError, type Reply, type Task } from '../model';
import { confusion, loadRecordedResults, labels, score, type CaseResult } from './results';
import { createDemoSession, type DemoState, type TaskState } from './session';

const taskNames: Record<Task, string> = { department: '担当部署', priority: '優先度' };
const taskList: Task[] = ['department', 'priority'];
const PASS = 20;
const MAX_CHARS = 60;

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const hex = (b: Uint8Array | number[]) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** Fixed labels for every fixture text, so a sample run can be checked against its answer. */
const known = new Map<string, { split: string; department: string; priority: string }>([
  ...corpus.development.map(c => [c.text, { split: '調整用', department: c.department, priority: c.priority }] as const),
  ...corpus.evaluation.map(c => [c.text, { split: '評価用', department: c.department, priority: c.priority }] as const),
]);

// ---------- evaluation section ----------

function scoreBar(label: string, value: number, of: number) {
  const ok = value >= PASS;
  return `<div class="score ${ok ? 'ok' : 'ng'}">
    <div class="score-head"><span>${label}</span><span class="score-num"><b>${value}</b>/${of}</span></div>
    <div class="score-track" role="img" aria-label="${label} ${value}/${of}件正解、基準は${PASS}件以上">
      <span class="score-fill" style="width:${(value / of) * 100}%"></span>
      <span class="score-mark" style="left:${(PASS / of) * 100}%"><span>基準 ${PASS}</span></span>
    </div></div>`;
}

function matrix(task: Task, results: CaseResult[]) {
  const { ids, counts } = confusion(results, task);
  const max = Math.max(...counts.flat(), 1);
  const head = ids.map(id => `<th scope="col">${labels[task][id]}</th>`).join('');
  const body = ids.map((id, i) => `<tr><th scope="row">${labels[task][id]}</th>${counts[i].map((n, j) =>
    `<td class="${n === 0 ? 'zero' : i === j ? 'hit' : 'miss'}" style="--a:${(0.25 + 0.75 * n / max).toFixed(2)}">${n}</td>`).join('')}</tr>`).join('');
  return `<figure class="matrix"><figcaption>${taskNames[task]}</figcaption>
    <div class="matrix-grid"><span class="axis-x">判定 →</span><span class="axis-y">正解 ↓</span>
    <table><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div></figure>`;
}

function verdict(task: Task, r: CaseResult) {
  const j = r[task];
  return `<div class="v ${j.correct ? 'ok' : 'ng'}"><span class="v-task">${taskNames[task]}</span>
    <span class="v-mark" aria-hidden="true">${j.correct ? '✓' : '✗'}</span>
    <span class="v-label">${labels[task][j.selected]}</span><span class="v-conf">${pct(j.confidence)}</span>
    ${j.correct ? '<span class="sr">正解</span>' : `<span class="v-exp">正解は${labels[task][j.expected]}</span>`}</div>`;
}

type Filter = 'all' | 'wrong' | 'department' | 'priority';
const filters: Record<Filter, [string, (r: CaseResult) => boolean]> = {
  all: ['すべて', () => true],
  wrong: ['誤りあり', r => !r.department.correct || !r.priority.correct],
  department: ['部署の誤り', r => !r.department.correct],
  priority: ['優先度の誤り', r => !r.priority.correct],
};

function caseList(results: CaseResult[], filter: Filter) {
  return results.filter(filters[filter][1]).map(r => `<li class="case">
    <p class="case-text">${esc(r.text)}</p>${verdict('department', r)}${verdict('priority', r)}
    <button type="button" class="link" data-try="${esc(r.text)}">この文で試す</button></li>`).join('');
}

function evaluationMarkup(results: CaseResult[], evaluation: Evaluation) {
  const total = results.length;
  const highTotal = results.filter(r => r.priority.expected === 'high').length;
  const highHit = results.filter(r => r.priority.expected === 'high' && r.priority.selected === 'high').length;
  const highCalls = results.filter(r => r.priority.selected === 'high').length;
  const ok = evaluation.rows.filter(r => r.reply).length;
  const filterButtons = (Object.keys(filters) as Filter[]).map((f, i) =>
    `<button type="button" class="seg" data-filter="${f}" aria-pressed="${i === 0}" aria-controls="rows">${filters[f][0]}<span>${results.filter(filters[f][1]).length}</span></button>`).join('');
  return `<section aria-labelledby="eval-h">
    <div class="section-head"><h2 id="eval-h">固定評価の結果</h2><span class="tag ng">不合格</span></div>
    <p class="hint">候補表現は調整用12件だけで決めて固定し、評価用24件（4部署×3優先度×2件）を${evaluation.started_at.slice(0, 10)}に1回だけ実行しました。</p>
    <div class="scores">${scoreBar('担当部署', score(results, 'department'), total)}${scoreBar('優先度', score(results, 'priority'), total)}</div>
    <ul class="facts">
      <li><b>${highHit}/${highTotal}</b> 高優先度の検出（見落としゼロ）</li>
      <li><b>${highCalls}/${total}</b> 件を「高」と判定</li>
      <li><b>${ok}/${total * 2}</b> API呼び出し成功</li>
    </ul>
    <p class="callout">優先度はほぼ全件を「高」と判定しており、高の見落としはない一方で低・通常を区別できていません。</p>
    <div class="matrices">${matrix('department', results)}${matrix('priority', results)}</div>
    <div class="table-head"><h3>全${total}件</h3><div class="segs" role="group" aria-label="表示する行">${filterButtons}</div></div>
    <ul class="cases" id="rows">${caseList(results, 'all')}</ul>
    <p class="hint small">記録：<code>artifacts/ticketing-ja/evaluation.json</code>。正解数は各ケースの実際の選択から数え直しています。</p>
  </section>`;
}

// ---------- page ----------

const samples = corpus.development.slice(0, 8);
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<header class="wrap top">
  <div class="brand"><span class="logo" aria-hidden="true"></span>openJev <span class="muted">· 検証デモ</span></div>
  <span id="conn" class="pill" role="status"><i></i><span>接続確認中…</span></span>
</header>
<div class="wrap hero">
  <h1>日本語チケット判定</h1>
  <p class="lede">社内問い合わせを日本語のままopenJevに渡し、<b>担当部署</b>と<b>優先度</b>を選ばせます。翻訳やキーワード補正はしていません。</p>
  <div class="banner" role="note"><span class="banner-icon" aria-hidden="true">!</span><div><strong>公開基準未達</strong>
    事前の日本語評価は公開基準に達していません。実運用の振り分けには使えません。</div></div>
</div>

<main class="wrap">
  <section aria-labelledby="try-h">
    <div class="section-head"><h2 id="try-h">試してみる</h2></div>
    <form id="form">
      <label for="text" class="sr">問い合わせ文</label>
      <div class="input">
        <textarea id="text" rows="2" maxlength="${MAX_CHARS}" placeholder="例：VPNにつながりません" required></textarea>
        <div class="input-foot">
          <span id="count" class="count">0/${MAX_CHARS}</span>
          <button id="go" type="submit" disabled>判定する <kbd>${/Mac|iP/.test(navigator.platform) ? '⌘' : 'Ctrl+'}↵</kbd></button>
        </div>
      </div>
      <div class="samples"><span class="samples-label">例文</span>${samples.map(s => `<button type="button" class="chip" data-text="${esc(s.text)}">${esc(s.text)}</button>`).join('')}</div>
    </form>
    <p class="hint small">入力は公開キャニスター <code>${CANISTER}</code> へ匿名のqueryとして送られます。<strong>架空の内容だけ</strong>を入力してください。上限は質問文・候補込みで<span id="limit">（接続後に表示）</span>、日本語で20字前後です。</p>
    <div id="out" class="out" aria-live="polite"></div>
  </section>

  <div id="evaluation"><section><p class="pending">評価記録を確認中…</p></section></div>
</main>
<footer class="wrap"><p>架空の小規模データでの結果です。日本語のチケット判定一般が不可能という結論ではなく、表示のスコアは校正済みの正答率ではありません。</p></footer>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const text = $<HTMLTextAreaElement>('text'), go = $<HTMLButtonElement>('go'), out = $('out'), conn = $('conn'), count = $('count');

function bars(task: Task, reply: Reply, expected?: string) {
  const rows = tasks[task].options.map((o, i) => {
    const p = reply.probabilities[i], on = o.id === reply.selected;
    return `<div class="bar ${on ? 'on' : ''}"><span class="bar-label">${labels[task][o.id]}${o.id === expected ? '<i class="ans" title="正解">正解</i>' : ''}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(p * 100).toFixed(1)}%"></span></span><span class="bar-pct">${pct(p)}</span></div>`;
  }).join('');
  const check = expected === undefined ? '' : reply.selected === expected
    ? '<span class="tag ok">✓ 正解</span>' : `<span class="tag ng">✗ 正解は${labels[task][expected]}</span>`;
  return `<div class="result"><div class="result-head"><span class="muted">${taskNames[task]}</span>${check}</div>
    <div class="result-pick">${labels[task][reply.selected]}</div>${rows}
    <div class="meta">${reply.input_tokens}トークン · ${(Number(reply.measured_instructions) / 1e9).toFixed(2)}B命令</div></div>`;
}

function explain(e: unknown) {
  if (e instanceof ModelChangedError) return 'モデルが更新されました。再試行すると最新の接続情報で判定します。';
  const m = String(e instanceof Error ? e.message : e);
  if (m.includes('TooLong') || m.includes('Capacity')) return '入力が長すぎます。もう少し短くしてください。';
  if (m.includes('Busy') || m.includes('Budget')) return 'キャニスターが混み合っています。少し待ってから再度お試しください。';
  if (m.includes('Invalid model response')) return '想定外の応答を受け取ったため表示を中止しました。';
  return `判定できませんでした（${esc(m.slice(0, 160))}）`;
}

function skeleton(task: Task) {
  return `<div class="result" aria-busy="true"><div class="result-head"><span class="muted">${taskNames[task]}</span></div>
    <div class="result-pick"><span class="sk sk-pick"></span></div>
    ${tasks[task].options.map(() => '<div class="bar"><span class="sk sk-label"></span><span class="bar-track sk"></span><span></span></div>').join('')}
    <div class="meta">判定中…</div></div>`;
}

function renderTask(task: Task, state: TaskState, expected?: string) {
  if (state.phase === 'success') return bars(task, state.reply, expected);
  if (state.phase === 'pending') return skeleton(task);
  if (state.phase === 'error') return `<div class="result"><div class="result-head"><span class="muted">${taskNames[task]}</span></div>
    <p class="error">${explain(state.error)}</p><button type="button" class="retry" data-retry="${task}">再試行</button></div>`;
  return '';
}

function setPill(kind: 'ok' | 'warn' | 'wait', label: string, title = '') {
  conn.className = `pill ${kind}`;
  conn.title = title;
  conn.querySelector('span')!.textContent = label;
}

function renderState(state: DemoState) {
  const connection = state.connection;
  if (connection.phase === 'connected') {
    const id = hex(connection.status.model), same = evaluation && id === hex(evaluation.status.model);
    setPill(same ? 'ok' : 'warn', `${!evaluation ? '接続済み（評価記録なし）' : same ? '評価時と同じモデル' : '評価時と異なるモデル'} · ${id.slice(0, 8)}`, `model ${id}`);
    $('limit').textContent = `${connection.status.max_tokens}トークン`;
  } else if (connection.phase === 'stale') setPill('warn', 'モデル更新を検知（接続情報を再確認します）');
  else if (connection.phase === 'error') setPill('warn', '接続できません（判定時に再接続）');
  else setPill('wait', '接続確認中…');
  const busy = Object.values(state.tasks).some(task => task.phase === 'pending');
  go.disabled = busy || !state.input.trim();
  count.textContent = `${state.input.length}/${MAX_CHARS}`;
  count.classList.toggle('near', state.input.length > 24);
  if (Object.values(state.tasks).every(task => task.phase === 'idle')) { out.innerHTML = ''; return; }
  const input = state.input.trim(), answer = known.get(input);
  out.innerHTML = `<div class="quote"><span>「${esc(input)}」</span>${answer ? `<span class="tag">${answer.split}データ・正解あり</span>` : ''}</div>
    <div class="results">${taskList.map(t => renderTask(t, state.tasks[t], answer?.[t])).join('')}</div>`;
}

const session = createDemoSession(connect, renderState);
function load(value: string, submit = false) {
  text.value = value;
  session.setInput(value);
  if (submit) void session.submit();
  else text.focus();
}
text.addEventListener('input', () => session.setInput(text.value));
text.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); $<HTMLFormElement>('form').requestSubmit(); }
});
app.querySelectorAll<HTMLButtonElement>('.chip').forEach(button => button.addEventListener('click', () => load(button.dataset.text!)));
$<HTMLFormElement>('form').addEventListener('submit', event => {
  event.preventDefault();
  session.setInput(text.value);
  void session.submit();
});
out.addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-retry]') : null;
  const task = button?.dataset.retry;
  if (task === 'department' || task === 'priority') void session.retry(task);
});
void session.ensureConnection().catch(() => { /* The connection error is shown by renderState. */ });

async function recordedResults() {
  if (!evaluation) throw new Error('ローカルの評価記録がありません。判定デモは引き続き利用できます。');
  return loadRecordedResults(corpusSource, evaluation);
}
void recordedResults().then(results => {
  const root = $('evaluation');
  root.innerHTML = evaluationMarkup(results, evaluation);
  root.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    const seg = target?.closest<HTMLButtonElement>('[data-filter]');
    if (seg) {
      root.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b === seg)));
      $('rows').innerHTML = caseList(results, seg.dataset.filter as Filter);
      return;
    }
    const tryButton = target?.closest<HTMLButtonElement>('[data-try]');
    if (tryButton) {
      $('try-h').scrollIntoView({ behavior: 'smooth', block: 'start' });
      load(tryButton.dataset.try!, true);
    }
  });
}).catch(error => {
  $('evaluation').innerHTML = `<section aria-labelledby="eval-h"><h2 id="eval-h">固定評価の結果</h2><p class="error" role="alert">${esc(String(error instanceof Error ? error.message : error))}</p></section>`;
});
