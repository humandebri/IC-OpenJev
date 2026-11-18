import { ModelChangedError, type Reply, type Status, type Task } from '../model';

export type DemoReply = Omit<Reply, 'logits'>;
type Client = { status: Status; decide(task: Task, text: string): Promise<DemoReply> };
export type TaskState = { phase: 'idle' | 'pending' } | { phase: 'success'; reply: DemoReply } | { phase: 'error'; error: unknown };
export type DemoState = {
  input: string;
  connection: { phase: 'idle' | 'connecting' | 'stale' } | { phase: 'connected'; status: Status } | { phase: 'error' };
  tasks: Record<Task, TaskState>;
};
const emptyTasks = (): Record<Task, TaskState> => ({ department: { phase: 'idle' }, priority: { phase: 'idle' } });

/** Own connection retries and invalidate responses when the input changes. No DOM or network on construction. */
export function createDemoSession(createClient: () => Promise<Client>, changed: (state: DemoState) => void) {
  let state: DemoState = { input: '', connection: { phase: 'idle' }, tasks: emptyTasks() };
  let cached: Promise<Client> | undefined;
  let generation = 0;
  const emit = () => changed(state);
  function ensureConnection(): Promise<Client> {
    if (cached) return cached;
    state = { ...state, connection: { phase: 'connecting' } }; emit();
    const attempt = Promise.resolve().then(createClient).then(client => {
      state = { ...state, connection: { phase: 'connected', status: client.status } }; emit();
      return client;
    }, error => {
      if (cached === attempt) cached = undefined;
      state = { ...state, connection: { phase: 'error' } }; emit();
      throw error;
    });
    cached = attempt;
    return attempt;
  }
  async function run(selected: Task[], canReconnect = true) {
    const token = generation, input = state.input.trim();
    if (!input) return;
    const pending = { ...state.tasks };
    for (const task of selected) pending[task] = { phase: 'pending' };
    state = { ...state, tasks: pending }; emit();
    let modelChanged: ModelChangedError | undefined;
    await Promise.all(selected.map(async task => {
      try {
        const client = await ensureConnection();
        if (token !== generation || modelChanged) return;
        const reply = await client.decide(task, input);
        if (token !== generation || modelChanged) return;
        state = { ...state, tasks: { ...state.tasks, [task]: { phase: 'success', reply } } };
      } catch (error) {
        if (token !== generation || modelChanged) return;
        if (error instanceof ModelChangedError) {
          modelChanged = error;
          cached = undefined;
          // Discard both tasks: retaining an earlier success would mix model versions.
          state = { ...state, connection: { phase: 'stale' }, tasks: {
            department: { phase: 'pending' }, priority: { phase: 'pending' },
          } };
          emit();
          return;
        }
        state = { ...state, tasks: { ...state.tasks, [task]: { phase: 'error', error } } };
      }
      emit();
    }));
    if (modelChanged && token === generation) {
      if (canReconnect) await run(['department', 'priority'], false);
      else {
        state = { ...state, connection: { phase: 'stale' }, tasks: {
          department: { phase: 'error', error: modelChanged }, priority: { phase: 'error', error: modelChanged },
        } };
        emit();
      }
    }
  }
  return {
    get state() { return state; },
    ensureConnection,
    setInput(input: string) {
      if (input === state.input) return;
      generation++;
      state = { ...state, input, tasks: emptyTasks() }; emit();
    },
    async submit() {
      if (Object.values(state.tasks).some(task => task.phase === 'pending')) return;
      await run(['department', 'priority']);
    },
    async retry(task: Task) {
      if (state.tasks[task].phase !== 'error') return;
      const stale = Object.values(state.tasks).some(result => result.phase === 'error' && result.error instanceof ModelChangedError);
      await run(stale ? ['department', 'priority'] : [task]);
    },
  };
}
