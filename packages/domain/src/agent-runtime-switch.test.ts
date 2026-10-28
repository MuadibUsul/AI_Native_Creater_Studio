import { describe, expect, it } from 'vitest';
import { AGENT_TURN_WORKFLOW } from '@ancs/contracts';
import type { DomainDeps } from './deps.js';
import { agentTurnWorkflow, legacyAgentRuntime, resolveAgentRuntime, unconfiguredAgentModel, type AgentRuntime } from './agent-runtime.js';
import type { WorkflowStepContext } from './workflow.js';

/** V7 运行时切换点（裁决 0021）：缺省 legacy 就是现有循环；DSH 运行时在 P2 前不可选；工作流只经切换点执行轮次。 */
describe('agent runtime switch point', () => {
  it('legacy is the existing loop and the only runtime available before P2', () => {
    expect(resolveAgentRuntime('legacy')).toBe(legacyAgentRuntime);
    expect(legacyAgentRuntime.kind).toBe('legacy');
    for (const kind of ['dsh_shadow', 'dsh_active'] as const) {
      expect(() => resolveAgentRuntime(kind)).toThrow(/not available in this build.*P2/);
    }
  });

  it('the turn workflow runs the turn through the configured runtime', async () => {
    const calls: { turnId: string; workflowRunId: string | null }[] = [];
    const fake: AgentRuntime = {
      kind: 'legacy',
      runTurn: (_deps, _ports, input) => { calls.push({ turnId: input.turnId, workflowRunId: input.workflowRunId }); return Promise.resolve({ turnId: input.turnId, proposalId: null }); },
    };
    const definition = agentTurnWorkflow({ model: unconfiguredAgentModel(), runtime: fake });
    expect(definition.type).toBe(AGENT_TURN_WORKFLOW);
    const step = definition.steps.find((candidate) => candidate.key === 'run');
    const context: WorkflowStepContext = {
      deps: {} as DomainDeps,
      run: { id: 'wfr_1', workspaceId: 'ws_1', projectId: 'prj_1', type: AGENT_TURN_WORKFLOW, input: { turnId: 'agt_1' }, outputs: {} },
      attempt: 1,
      jobId: null,
    };
    await expect(step?.run(context)).resolves.toEqual({ kind: 'DONE', output: { turnId: 'agt_1', proposalId: null } });
    expect(calls).toEqual([{ turnId: 'agt_1', workflowRunId: 'wfr_1' }]);
  });
});
