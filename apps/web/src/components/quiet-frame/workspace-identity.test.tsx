import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { voiceCloneSchema, type VoiceClone } from '@ancs/contracts';
import { I18nProvider } from '@/i18n/I18nProvider';
import { mockClient, renderWithClient } from '@/test-utils.js';
import { WorkspaceIdentity } from './workspace-identity.js';

describe('Quiet Frame 声音样本', () => {
  it('从素材库读取已上传音频，选择 READY 版本后提交音质检测', async () => {
    const uploadedAssets = [
      { id: 'ast_voice_ready', assetType: 'VOICE_AUDIO', status: 'READY', currentVersionId: 'av_voice_ready' },
      { id: 'ast_voice_pending', assetType: 'VOICE_AUDIO', status: 'UPLOADING', currentVersionId: null },
    ];
    const listAssets = vi.fn().mockImplementation((_workspaceId: string, query: { assetType: string }) =>
      Promise.resolve(uploadedAssets.filter((asset) => asset.assetType === query.assetType)));
    const addSample = vi.fn().mockResolvedValue({ id: 'sample_1' });
    const submit = vi.fn();
    const client = mockClient({
      workspaces: { get: vi.fn().mockResolvedValue({ role: 'EDITOR' }) },
      creatorIdentities: { list: vi.fn().mockResolvedValue([{ id: 'cid_1', displayName: '作者', updatedAt: '2026-10-07T00:00:00Z', brandIdentity: null, voiceIdentity: null }]) },
      speechProfiles: { list: vi.fn().mockResolvedValue([]) },
      voiceClone: {
        state: vi.fn().mockResolvedValue({ clone: null, consent: { statementVersion: 'v1', revokedAt: null }, samples: [] }),
        consentStatement: vi.fn().mockResolvedValue({ statement: '当前授权声明' }),
        addSample,
        submit,
      },
      assets: { list: listAssets },
    });
    renderWithClient(<WorkspaceIdentity workspaceId="ws_1" />, client);
    await userEvent.click(await screen.findByRole('button', { name: /创建我的声音/ }));
    await screen.findByRole('option', { name: 'ast_voice_ready' });
    expect(listAssets).toHaveBeenCalledWith('ws_1', { assetType: 'VOICE_AUDIO' });
    expect(screen.queryByRole('option', { name: 'ast_voice_pending' })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('选择音频素材'), 'ast_voice_ready');
    await userEvent.click(screen.getByRole('button', { name: '检测并添加样本' }));
    await waitFor(() => expect(addSample).toHaveBeenCalledWith('ws_1', 'cid_1', { assetId: 'ast_voice_ready', assetVersionId: 'av_voice_ready' }));
    expect((await screen.findByRole('status')).textContent).toContain('样本已提交音质检测');
    expect(submit).not.toHaveBeenCalled();
  });
});

function voiceClient(patch: Partial<VoiceClone> = {}, role = 'EDITOR') {
  const clone = voiceCloneSchema.parse({
    id: 'vcl_1', workspaceId: 'ws_1', creatorIdentityId: 'cid_1', kind: 'INSTANT', provider: 'mock-voice',
    mode: 'MANAGED', status: 'READY', qualityVerdict: 'PASS', providerVoiceId: 'provider_voice_1',
    createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z', ...patch,
  });
  const initialState = { clone, consent: null, samples: [], boundToIdentity: clone.status === 'READY' };
  const state = vi.fn().mockResolvedValue(initialState);
  const refresh = vi.fn().mockResolvedValue(clone);
  const retire = vi.fn().mockResolvedValue(clone);
  const unlink = vi.fn().mockResolvedValue(clone);
  const submit = vi.fn(), retry = vi.fn(), deleteProviderVoice = vi.fn();
  const client = mockClient({
    workspaces: { get: vi.fn().mockResolvedValue({ role }) },
    creatorIdentities: { list: vi.fn().mockResolvedValue([{ id: 'cid_1', displayName: '作者', updatedAt: '2026-10-07T00:00:00Z', brandIdentity: null, voiceIdentity: null }]) },
    speechProfiles: { list: vi.fn().mockResolvedValue([]) },
    assets: { list: vi.fn().mockResolvedValue([]) },
    voiceClone: { state, refresh, retire, unlink, submit, retry, deleteProviderVoice, consentStatement: vi.fn().mockResolvedValue({ statement: '当前授权声明' }) },
  });
  return { client, clone, initialState, state, refresh, retire, unlink, submit, retry, deleteProviderVoice };
}

async function openVoiceManagement(client: ReturnType<typeof mockClient>) {
  renderWithClient(<WorkspaceIdentity workspaceId="ws_1" />, client);
  await userEvent.click(await screen.findByRole('button', { name: /管理我的声音/ }));
  await screen.findByRole('heading', { name: '克隆状态' });
}

describe('Quiet Frame 声音生命周期', () => {
  it('本地退休先说明影响；取消不写入，确认后读取服务端状态且保留供应商声音', async () => {
    const fixture = voiceClient();
    const retired = { ...fixture.clone, status: 'RETIRED', retiredAt: '2026-10-07T01:00:00Z' };
    fixture.retire.mockImplementation(async () => {
      fixture.state.mockResolvedValue({ ...fixture.initialState, clone: retired, boundToIdentity: false });
      return retired;
    });
    await openVoiceManagement(fixture.client);
    await userEvent.click(screen.getByRole('button', { name: '本地退休' }));
    let dialog = screen.getByRole('dialog', { name: '确认本地退休' });
    expect(within(dialog).getByText(/保留历史引用与供应商侧声音/)).not.toBeNull();
    expect(fixture.retire).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fixture.retire).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '本地退休' }));
    dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: '确认本地退休' }));
    await waitFor(() => expect(fixture.retire).toHaveBeenCalledExactlyOnceWith('ws_1', 'cid_1'));
    expect(await screen.findByText('RETIRED · mock-voice')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toContain('声音已在本地退休，供应商侧声音保留');
    expect(screen.queryByRole('button', { name: '本地退休' })).toBeNull();
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull();
    expect(fixture.deleteProviderVoice).not.toHaveBeenCalled();
    expect(fixture.submit).not.toHaveBeenCalled();
    expect(fixture.retry).not.toHaveBeenCalled();
  });

  it('已退休的声音可经独立确认解绑，未授权不妨碍停止使用声音', async () => {
    const fixture = voiceClient({ status: 'RETIRED', retiredAt: '2026-10-07T01:00:00Z' });
    fixture.unlink.mockImplementation(async () => {
      const clone = { ...fixture.clone, status: 'UNLINKED', unlinkedAt: '2026-10-07T02:00:00Z' };
      fixture.state.mockResolvedValue({ ...fixture.initialState, clone });
      return clone;
    });
    await openVoiceManagement(fixture.client);
    await userEvent.click(screen.getByRole('button', { name: '平台解绑' }));
    const dialog = screen.getByRole('dialog', { name: '确认平台解绑' });
    expect(within(dialog).getByText(/清除当前身份的声音关联/)).not.toBeNull();
    expect(fixture.unlink).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: '确认平台解绑' }));
    await waitFor(() => expect(fixture.unlink).toHaveBeenCalledExactlyOnceWith('ws_1', 'cid_1'));
    expect(await screen.findByText('UNLINKED · mock-voice')).not.toBeNull();
    expect(screen.queryByRole('button', { name: '平台解绑' })).toBeNull();
    expect(fixture.retire).not.toHaveBeenCalled();
    expect(fixture.deleteProviderVoice).not.toHaveBeenCalled();
  });

  it('训练中仅可确认查询现有任务；失败反馈不触发付费重试', async () => {
    const fixture = voiceClient({ status: 'TRAINING', providerJobId: 'provider_job_1', providerVoiceId: null });
    fixture.refresh.mockImplementation(async () => {
      const clone = { ...fixture.clone, status: 'FAILED', failure: { code: 'TRAINING_FAILED', message: '供应商训练失败', at: '2026-10-07T01:00:00Z', retryable: true } };
      fixture.state.mockResolvedValue({ ...fixture.initialState, clone });
      return clone;
    });
    await openVoiceManagement(fixture.client);
    expect(screen.queryByRole('button', { name: '本地退休' })).toBeNull();
    expect(screen.queryByRole('button', { name: '平台解绑' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '查询训练进度' }));
    expect(fixture.refresh).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认查询训练进度' }));
    await waitFor(() => expect(fixture.refresh).toHaveBeenCalledExactlyOnceWith('ws_1', 'cid_1'));
    expect(await screen.findByText(/训练失败：供应商训练失败/)).not.toBeNull();
    expect(screen.queryByRole('button', { name: /重试训练/ })).toBeNull();
    expect(fixture.submit).not.toHaveBeenCalled();
    expect(fixture.retry).not.toHaveBeenCalled();
  });

  it('查看者只能重新读取状态，不显示写操作', async () => {
    const fixture = voiceClient({ status: 'TRAINING', providerJobId: 'provider_job_1' }, 'VIEWER');
    await openVoiceManagement(fixture.client);
    expect(screen.queryByRole('button', { name: '查询训练进度' })).toBeNull();
    expect(screen.queryByRole('button', { name: '本地退休' })).toBeNull();
    expect(screen.queryByRole('button', { name: '平台解绑' })).toBeNull();
    const initialCalls = fixture.state.mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: '刷新状态' }));
    await waitFor(() => expect(fixture.state.mock.calls.length).toBeGreaterThan(initialCalls));
    expect(fixture.refresh).not.toHaveBeenCalled();
    expect(fixture.retire).not.toHaveBeenCalled();
    expect(fixture.unlink).not.toHaveBeenCalled();
  });

  it('确认前发现克隆版本变化时阻断写入，避免操作新克隆', async () => {
    const fixture = voiceClient();
    await openVoiceManagement(fixture.client);
    await userEvent.click(screen.getByRole('button', { name: '本地退休' }));
    fixture.state.mockResolvedValue({ ...fixture.initialState, clone: { ...fixture.clone, id: 'vcl_new' } });
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认本地退休' }));
    expect((await screen.findByRole('alert')).textContent).toContain('声音状态已变化');
    expect(fixture.retire).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).not.toBeNull();
  });

  it('服务端拒绝操作时保留确认窗口和真实失败，不显示成功状态', async () => {
    const fixture = voiceClient();
    fixture.retire.mockRejectedValue(new Error('没有操作权限'));
    await openVoiceManagement(fixture.client);
    await userEvent.click(screen.getByRole('button', { name: '本地退休' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认本地退休' }));
    expect((await screen.findByRole('alert')).textContent).toContain('操作未完成：没有操作权限');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('dialog')).not.toBeNull();
    expect(fixture.retire).toHaveBeenCalledTimes(1);
    expect(fixture.submit).not.toHaveBeenCalled();
  });
});

describe('Quiet Frame 身份页英文界面', () => {
  it('英文界面：身份、声音生命周期与确认窗口全部显示英文，没有中文残留', async () => {
    const clone = voiceCloneSchema.parse({
      id: 'vcl_1', workspaceId: 'ws_1', creatorIdentityId: 'cid_1', kind: 'INSTANT', provider: 'mock-voice',
      mode: 'MANAGED', status: 'READY', qualityVerdict: 'PASS', providerVoiceId: 'provider_voice_1',
      createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z',
    });
    const retire = vi.fn();
    const client = mockClient({
      workspaces: { get: vi.fn().mockResolvedValue({ role: 'EDITOR' }) },
      creatorIdentities: { list: vi.fn().mockResolvedValue([{ id: 'cid_1', displayName: 'Author', updatedAt: '2026-10-07T00:00:00Z', brandIdentity: null, voiceIdentity: null }]) },
      speechProfiles: { list: vi.fn().mockResolvedValue([]) },
      assets: { list: vi.fn().mockResolvedValue([]) },
      voiceClone: {
        state: vi.fn().mockResolvedValue({ clone, consent: null, samples: [], boundToIdentity: true }),
        consentStatement: vi.fn().mockResolvedValue({ statement: 'Consent statement v1' }),
        retire,
      },
    });
    const { container } = renderWithClient(<I18nProvider initialLocale="en"><WorkspaceIdentity workspaceId="ws_1" /></I18nProvider>, client);
    expect(await screen.findByRole('heading', { name: 'Make every piece unmistakably yours.' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Save identity' })).not.toBeNull();
    expect(screen.getByLabelText('Identity name')).not.toBeNull();
    expect(await screen.findByText('Delivery style')).not.toBeNull();
    expect(screen.getByText('Brand look')).not.toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: /Manage my voice/ }));
    await screen.findByRole('heading', { name: 'Clone status' });
    expect(await screen.findByText('Consent statement v1')).not.toBeNull();
    expect(screen.getByText('READY · mock-voice')).not.toBeNull();
    expect(screen.getByText(/Linked to this identity · Updated /)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Confirm consent' })).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Retire locally' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm local retirement' });
    expect(within(dialog).getByText('Identity: Author · Current status: READY')).not.toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).not.toBeNull();
    expect(retire).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/[一-鿿]/);
  });
});
