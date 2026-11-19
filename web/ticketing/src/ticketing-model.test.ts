import { describe, expect, it, vi } from 'vitest';
import { createTicketingClient, validateTicket, type TicketingActor, type TicketReply } from './ticketing-model';
import { ModelChangedError, type Status } from './model';
import { createDemoSession } from './demo/session';

const status: Status = { model: Array(32).fill(7), warmed: true, max_tokens: 64, budget: 4_500_000_000n };
const reply = (): TicketReply => ({ model: status.model, input_tokens: 6, measured_instructions: 600_000_000n,
  department: { labels: ['it', 'hr', 'finance', 'admin'], selected: 'it', probabilities: [0.7, 0.1, 0.1, 0.1] },
  priority: { labels: ['low', 'normal', 'high'], selected: 'normal', probabilities: [0.1, 0.8, 0.1] },
});
function actor() {
  return {
    ticketing_info: vi.fn(async () => ({ model: status.model, ready: true })),
    ticketing_query_limits: vi.fn(async () => ({ calibrated: true, max_tokens: 64, target_instructions: status.budget })),
    classify_ticket: vi.fn<TicketingActor['classify_ticket']>(async () => ({ Ok: reply() })),
  };
}

describe('Japanese ticketing API', () => {
  it('uses one query for both tasks and makes a fresh query on resubmission', async () => {
    const a = actor(), client = await createTicketingClient(a);
    const session = createDemoSession(async () => client, () => {});
    session.setInput('VPNにつながりません');
    await session.submit();
    expect(a.classify_ticket).toHaveBeenCalledExactlyOnceWith('VPNにつながりません');
    expect(session.state.tasks.department).toMatchObject({ phase: 'success', reply: { selected: 'it', confidence: 0.7 } });
    expect(session.state.tasks.priority).toMatchObject({ phase: 'success', reply: { selected: 'normal', confidence: 0.8 } });
    await session.submit();
    expect(a.classify_ticket).toHaveBeenCalledTimes(2);
  });
  it('does not cache failed queries, allowing retries', async () => {
    const a = actor(), client = await createTicketingClient(a);
    a.classify_ticket.mockResolvedValueOnce({ Err: { Busy: null } });
    await expect(client.decide('department', 'request')).rejects.toThrow('Busy');
    await expect(client.decide('department', 'request')).resolves.toMatchObject({ selected: 'it' });
    expect(a.classify_ticket).toHaveBeenCalledTimes(2);
  });
  it('rejects an unavailable or uncalibrated model before inference', async () => {
    const a = actor();
    a.ticketing_query_limits.mockResolvedValue({ calibrated: false, max_tokens: 64, target_instructions: status.budget });
    await expect(createTicketingClient(a)).rejects.toThrow('Model unavailable');
    expect(a.classify_ticket).not.toHaveBeenCalled();
  });
  it('detects model changes without mixing results', () => {
    expect(() => validateTicket({ ...reply(), model: Array(32).fill(8) }, status)).toThrow(ModelChangedError);
  });
  it.each([
    { input_tokens: 65 }, { measured_instructions: status.budget + 1n },
    { department: { ...reply().department, selected: 'unknown' } },
    { priority: { ...reply().priority, probabilities: [0, NaN, 1] } },
    { priority: { ...reply().priority, probabilities: [0.1, 0.1, 0.1] } },
    { priority: { ...reply().priority, labels: ['high', 'normal', 'low'] } },
  ])('rejects invalid results', patch => {
    expect(() => validateTicket({ ...reply(), ...patch }, status)).toThrow('Invalid model response');
  });
});
