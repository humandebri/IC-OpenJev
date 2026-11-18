import { describe, expect, it, vi } from 'vitest';
import { createDemoSession, type DemoState } from './session';
import { ModelChangedError, tasks, type Reply, type Status, type Task } from '../model';

const status: Status = { model: Array(32).fill(7), warmed: true, max_tokens: 52, budget: 5_000_000_000n };
function reply(task: Task, selected: string = tasks[task].options[0].id): Reply {
  const ids = tasks[task].options.map(o => o.id);
  return { ids, selected, probabilities: ids.map(id => id === selected ? 1 : 0), logits: ids.map(() => 0),
    confidence: 1, model: status.model, input_tokens: 30, measured_instructions: 3_000_000_000n };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function client() {
  return { status, decide: vi.fn(async (task: Task, _text: string) => reply(task)) };
}

describe('demo connection and independent task results', () => {
  it('refreshes after an update and reruns both tasks without mixing model versions', async () => {
    const old = client(), updated = client();
    updated.status = { ...status, model: Array(32).fill(8), max_tokens: 60 };
    updated.decide = vi.fn(async (task: Task) => ({ ...reply(task), model: updated.status.model }));
    const priority = deferred<Reply>();
    old.decide = vi.fn(async (task: Task) => task === 'department' ? reply(task) : priority.promise);
    const connect = vi.fn().mockResolvedValueOnce(old).mockResolvedValue(updated);
    const states: DemoState[] = [];
    const session = createDemoSession(connect, state => states.push(state));
    session.setInput('request');
    const first = session.submit();
    await vi.waitFor(() => expect(session.state.tasks.department.phase).toBe('success'));
    priority.reject(new ModelChangedError());
    await first;
    expect(connect).toHaveBeenCalledTimes(2);
    expect(updated.decide.mock.calls.map(([task]) => task)).toEqual(['department', 'priority']);
    expect(session.state.connection).toEqual({ phase: 'connected', status: updated.status });
    for (const result of Object.values(session.state.tasks)) {
      expect(result.phase).toBe('success');
      if (result.phase === 'success') expect(result.reply.model).toEqual(updated.status.model);
    }
    const stale = states.find(state => state.connection.phase === 'stale')!;
    expect(stale.tasks.department.phase).toBe('pending');
    expect(stale.tasks.priority.phase).toBe('pending');
  });
  it('shares a single reconnection when both tasks detect the update', async () => {
    const old = client(), updated = client();
    old.decide = vi.fn(async () => { throw new ModelChangedError(); });
    const connect = vi.fn().mockResolvedValueOnce(old).mockResolvedValue(updated);
    const session = createDemoSession(connect, () => {});
    session.setInput('request');
    await session.submit();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(updated.decide).toHaveBeenCalledTimes(2);
    expect(session.state.tasks.department.phase).toBe('success');
    expect(session.state.tasks.priority.phase).toBe('success');
  });
  it('bounds automatic refreshes and allows a later manual retry to recover', async () => {
    const changing = client(), ready = client();
    changing.decide = vi.fn(async () => { throw new ModelChangedError(); });
    const connect = vi.fn().mockResolvedValueOnce(changing).mockResolvedValueOnce(changing).mockResolvedValue(ready);
    const session = createDemoSession(connect, () => {});
    session.setInput('request');
    await session.submit();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(session.state.connection.phase).toBe('stale');
    expect(session.state.tasks.department.phase).toBe('error');
    expect(session.state.tasks.priority.phase).toBe('error');
    await session.retry('priority');
    expect(connect).toHaveBeenCalledTimes(3);
    expect(ready.decide).toHaveBeenCalledTimes(2);
    expect(session.state.tasks.department.phase).toBe('success');
    expect(session.state.tasks.priority.phase).toBe('success');
  });
  it('does not reconnect on malformed responses', async () => {
    const c = client();
    c.decide = vi.fn(async () => { throw new Error('Invalid model response'); });
    const connect = vi.fn(async () => c);
    const session = createDemoSession(connect, () => {});
    session.setInput('request');
    await session.submit();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(session.state.tasks.priority.phase).toBe('error');
  });
  it('does not reconnect for an old input that detected an update after input changed', async () => {
    const c = client(), pending = deferred<Reply>();
    c.decide = vi.fn(async () => pending.promise);
    const connect = vi.fn(async () => c);
    const session = createDemoSession(connect, () => {});
    session.setInput('old');
    const first = session.submit();
    await vi.waitFor(() => expect(c.decide).toHaveBeenCalledTimes(2));
    session.setInput('new');
    pending.reject(new ModelChangedError());
    await first;
    expect(connect).toHaveBeenCalledTimes(1);
    expect(session.state.input).toBe('new');
    expect(session.state.tasks.department.phase).toBe('idle');
  });
  it('reconnects on submission after the initial connection failed', async () => {
    const c = client(), connect = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(c);
    const session = createDemoSession(connect, () => {});
    await expect(session.ensureConnection()).rejects.toThrow('offline');
    expect(session.state.connection.phase).toBe('error');
    session.setInput('VPNにつながりません');
    await session.submit();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(session.state.connection.phase).toBe('connected');
    expect(session.state.tasks.department.phase).toBe('success');
    expect(session.state.tasks.priority.phase).toBe('success');
  });
  it('shares an in-flight connection and retries it after failure', async () => {
    const pending = deferred<ReturnType<typeof client>>();
    const connect = vi.fn(() => pending.promise);
    const session = createDemoSession(connect, () => {});
    const a = session.ensureConnection(), b = session.ensureConnection();
    expect(a).toBe(b);
    pending.resolve(client());
    await Promise.all([a, b]);
    expect(connect).toHaveBeenCalledTimes(1);
  });
  it('shows a success while the other task is pending, then keeps it after failure and retry', async () => {
    const pending = deferred<Reply>(), c = client();
    let priorityCalls = 0;
    c.decide = vi.fn(async (task: Task) => task === 'department' ? reply(task) : ++priorityCalls === 1 ? pending.promise : reply(task));
    const states: DemoState[] = [];
    const session = createDemoSession(async () => c, state => states.push(state));
    session.setInput('VPNにつながりません');
    const first = session.submit();
    await vi.waitFor(() => expect(session.state.tasks.department.phase).toBe('success'));
    expect(session.state.tasks.priority.phase).toBe('pending');
    // A failed independent query must not discard the department result.
    pending.reject(new Error('priority offline'));
    await first;
    const department = session.state.tasks.department;
    expect(department.phase).toBe('success');
    expect(session.state.tasks.priority.phase).toBe('error');
    await session.retry('priority');
    expect(session.state.tasks.department).toBe(department);
    expect(session.state.tasks.priority.phase).toBe('success');
    expect(c.decide.mock.calls.map(([task]) => task)).toEqual(['department', 'priority', 'priority']);
    expect(states.some(s => s.tasks.department.phase === 'success' && s.tasks.priority.phase === 'pending')).toBe(true);
  });
  it('lets a failed task reconnect after both tasks failed to connect', async () => {
    const c = client(), connect = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(c);
    const session = createDemoSession(connect, () => {});
    session.setInput('経費精算の方法を教えて');
    await session.submit();
    expect(session.state.tasks.department.phase).toBe('error');
    expect(session.state.tasks.priority.phase).toBe('error');
    await session.retry('department');
    expect(connect).toHaveBeenCalledTimes(2);
    expect(c.decide).toHaveBeenCalledTimes(1);
    expect(session.state.tasks.department.phase).toBe('success');
    expect(session.state.tasks.priority.phase).toBe('error');
  });
  it('ignores old replies after input changes and a new submission completes', async () => {
    const old = { department: deferred<Reply>(), priority: deferred<Reply>() }, c = client();
    c.decide = vi.fn(async (task: Task, text: string) => text === 'old' ? old[task].promise : reply(task));
    const session = createDemoSession(async () => c, () => {});
    session.setInput('old');
    const first = session.submit();
    await vi.waitFor(() => expect(c.decide).toHaveBeenCalledTimes(2));
    session.setInput('new');
    expect(session.state.tasks.department.phase).toBe('idle');
    await session.submit();
    const completed = session.state;
    old.department.resolve(reply('department', 'hr'));
    old.priority.resolve(reply('priority', 'high'));
    await first;
    expect(session.state).toBe(completed);
    expect(session.state.input).toBe('new');
  });
  it('does not send stale input while waiting for a connection', async () => {
    const pending = deferred<ReturnType<typeof client>>(), c = client();
    const session = createDemoSession(() => pending.promise, () => {});
    session.setInput('old');
    const first = session.submit();
    session.setInput('new');
    pending.resolve(c);
    await first;
    expect(c.decide).not.toHaveBeenCalled();
    expect(session.state.tasks.department.phase).toBe('idle');
  });
  it('does not duplicate pending submissions or retry successful tasks', async () => {
    const pending = deferred<void>(), c = client();
    c.decide = vi.fn(async (task: Task) => { await pending.promise; return reply(task); });
    const session = createDemoSession(async () => c, () => {});
    session.setInput('request');
    const first = session.submit();
    await session.submit();
    await vi.waitFor(() => expect(c.decide).toHaveBeenCalledTimes(2));
    pending.resolve();
    await first;
    await session.retry('department');
    expect(c.decide).toHaveBeenCalledTimes(2);
  });
});
