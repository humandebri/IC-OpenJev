import './style.css';
import corpus from '../../../../fixtures/ticketing-ja/cases.json';
import { CANISTER, tasks, ModelChangedError, type Task } from '../model';
import { connectTicketing } from '../ticketing-model';
import { labels } from './results';
import { createDemoSession, type DemoReply, type DemoState, type TaskState } from './session';

const taskNames: Record<Task, string> = { department: '担当部署', priority: '優先度' };
const taskList: Task[] = ['department', 'priority'];
const MAX_CHARS = 200;

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const hex = (b: Uint8Array | number[]) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** Fixed labels for every fixture text, so a sample run can be checked against its answer. */
const known = new Map<string, { split: string; department: string; priority: string }>([
  ...corpus.development.map(c => [c.text, { split: '調整用', department: c.department, priority: c.priority }] as const),
  ...corpus.evaluation.map(c => [c.text, { split: '評価用', department: c.department, priority: c.priority }] as const),
]);

// ---------- page ----------

const samples = corpus.development.slice(0, 8);
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<header class="wrap top">
  <div class="brand"><span class="logo" aria-hidden="true"></span>ModernBERT-Ja <span class="muted">· チケット分類</span></div>
  <span id="conn" class="pill" role="status"><i></i><span>接続確認中…</span></span>
</header>
<div class="wrap hero">
  <h1>日本語チケット判定</h1>
  <p class="lede">日本語の社内問い合わせから、<b>担当部署</b>と<b>優先度</b>を判定します。</p>
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
    <p class="hint small">入力は公開キャニスター <code>${CANISTER}</code> へ匿名のqueryとして送られます。<strong>架空の内容だけ</strong>を入力してください。入力上限は<span id="limit">（接続後に表示）</span>です。長い文章は短くまとめてください。</p>
    <div id="out" class="out" aria-live="polite"></div>
  </section>

  <section aria-labelledby="about-h"><h2 id="about-h">このデモについて</h2>
    <p class="hint small">使用モデルは <a href="https://huggingface.co/sbintuitions/modernbert-ja-130m" target="_blank" rel="noopener noreferrer">sbintuitions/modernbert-ja-130m</a> です。部署・優先度の分類向けに追加学習したINT8量子化版を使用し、一度の推論で両方を判定します。</p>
    <p class="hint small">入力と結果はこの画面に保存しません。推論はInternet Computer上の公開APIで実行されます。</p></section>
</main>
<footer class="wrap"><p>ModernBERT-Ja · 日本語チケット分類。表示のスコアは校正済みの正答率ではありません。</p></footer>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const text = $<HTMLTextAreaElement>('text'), go = $<HTMLButtonElement>('go'), out = $('out'), conn = $('conn'), count = $('count');

function bars(task: Task, reply: DemoReply, expected?: string) {
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
    const id = hex(connection.status.model);
    setPill('ok', `ModernBERT-Ja · 接続済み`, `model ${id}`);
    $('limit').textContent = `${connection.status.max_tokens}トークン`;
  } else if (connection.phase === 'stale') setPill('warn', 'モデル更新を検知（接続情報を再確認します）');
  else if (connection.phase === 'error') setPill('warn', '接続できません（判定時に再接続）');
  else setPill('wait', '接続確認中…');
  const busy = Object.values(state.tasks).some(task => task.phase === 'pending');
  go.disabled = busy || !state.input.trim();
  count.textContent = `${state.input.length}/${MAX_CHARS}`;
  count.classList.toggle('near', state.input.length > MAX_CHARS * 0.8);
  if (Object.values(state.tasks).every(task => task.phase === 'idle')) { out.innerHTML = ''; return; }
  const input = state.input.trim(), answer = known.get(input);
  out.innerHTML = `<div class="quote"><span>「${esc(input)}」</span>${answer ? `<span class="tag">${answer.split}データ・正解あり</span>` : ''}</div>
    <div class="results">${taskList.map(t => renderTask(t, state.tasks[t], answer?.[t])).join('')}</div>`;
}

const session = createDemoSession(connectTicketing, renderState);
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
