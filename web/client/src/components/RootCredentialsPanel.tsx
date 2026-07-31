import React, { useEffect, useMemo, useState } from 'react';
import { Descriptions, Tag, Button, Space, message, Divider, Tooltip, Alert, Popconfirm } from 'antd';
import { ReloadOutlined, CopyOutlined, EyeOutlined, EyeInvisibleOutlined, KeyOutlined, SafetyCertificateOutlined, DeleteOutlined, UnlockOutlined } from '@ant-design/icons';
import { api } from '../api';

interface TempCreds {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
  region: string;
}

interface Props {
  accountId: string;
  rootCredentials: any;
  // 是否具备根用户凭证操作权限（admin 或被授予 root_access）。无权限时隐藏三个敏感功能。
  canRoot?: boolean;
  // 父组件是否仍在拉取账户详情（含根凭证状态）。为 true 时状态区显示加载中，但操作按钮始终可见。
  loading?: boolean;
}

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    message.success(`已复制${label}`);
  } catch {
    message.error('复制失败，请手动选择复制');
  }
}

const CredRow: React.FC<{ label: string; value: string; secret?: boolean; reveal?: boolean }> = ({ label, value, secret, reveal }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
    <span style={{ width: 128, flexShrink: 0, color: '#64748B', fontSize: 12 }}>{label}</span>
    <code style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', background: '#f6f8fa', padding: '2px 6px', borderRadius: 4 }}>
      {secret && !reveal ? '••••••••••••••••' : value}
    </code>
    <Tooltip title="复制">
      <Button size="small" type="text" aria-label={`复制${label}`} icon={<CopyOutlined />} onClick={() => copy(value, label)} />
    </Tooltip>
  </div>
);

const RootCredentialsPanel: React.FC<Props> = ({ accountId, rootCredentials, canRoot, loading: detailLoading }) => {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 769;
  const [creds, setCreds] = useState<TempCreds | null>(null);
  const [loading, setLoading] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [mfaLoading, setMfaLoading] = useState(false);
  const [pwdLoading, setPwdLoading] = useState(false);
  // 操作成功后对根用户状态做本地覆盖（无需等待父组件重新拉取）
  const [statusOverride, setStatusOverride] = useState<Record<string, any>>({});
  // 面板内"刷新状态"拉取到的最新数据，覆盖父组件传入的初始 rootCredentials
  const [fetchedStatus, setFetchedStatus] = useState<any>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  // 切换账户/挂载时：清空本地覆盖与刷新结果，并从 sessionStorage 恢复仍在有效期内的临时凭证
  useEffect(() => {
    setReveal(false); setStatusOverride({}); setFetchedStatus(null);
    try {
      const raw = sessionStorage.getItem(`awstool:tempCreds:${accountId}`);
      if (raw) {
        const c = JSON.parse(raw);
        if (c?.expiration && new Date(c.expiration).getTime() > Date.now()) {
          setCreds(c); setNow(Date.now());
          return;
        }
        sessionStorage.removeItem(`awstool:tempCreds:${accountId}`);
      }
    } catch { /* ignore */ }
    setCreds(null);
  }, [accountId]);

  const status = { ...(fetchedStatus ?? rootCredentials), ...statusOverride };

  const refreshStatus = async () => {
    setStatusLoading(true);
    try {
      const res = await api.getRootCredentials(accountId);
      if (res.success) { setFetchedStatus(res.data); setStatusOverride({}); }
      else message.error(res.error || '刷新失败');
    } catch (e: any) {
      message.error(e.message || '刷新失败');
    } finally {
      setStatusLoading(false);
    }
  };

  const handleDeleteMfa = async () => {
    setMfaLoading(true);
    try {
      const res = await api.deleteRootMFA(accountId);
      if (res.success) {
        setStatusOverride(o => ({ ...o, mfaActive: false }));
        message.success('已删除根用户 MFA');
      } else {
        message.error(res.error || '删除失败');
      }
    } catch (e: any) {
      message.error(e.message || '删除失败');
    } finally {
      setMfaLoading(false);
    }
  };

  const handleRecoverPassword = async () => {
    setPwdLoading(true);
    try {
      const res = await api.recoverRootPassword(accountId);
      if (res.success) {
        message.success(res.data?.alreadyNoPassword
          ? '该根用户本来就没有密码，现在即可去控制台用根邮箱「忘记密码」重置'
          : '已删除根用户密码，现在可去控制台用根邮箱「忘记密码」重置');
      } else {
        message.error(res.error || '恢复失败');
      }
    } catch (e: any) {
      message.error(e.message || '恢复失败');
    } finally {
      setPwdLoading(false);
    }
  };

  const handleDeleteAccessKey = async (keyId: string) => {
    setDeletingKey(keyId);
    try {
      const res = await api.deleteRootAccessKey(accountId, keyId);
      if (res.success) {
        // 从当前展示的密钥列表里移除（本地覆盖，无需重拉）
        setStatusOverride(o => {
          const cur = Array.isArray(o.accessKeys) ? o.accessKeys : (status.accessKeys || []);
          return { ...o, accessKeys: cur.filter((k: any) => k.id !== keyId) };
        });
        message.success('已删除访问密钥');
      } else {
        message.error(res.error || '删除失败');
      }
    } catch (e: any) {
      message.error(e.message || '删除失败');
    } finally {
      setDeletingKey(null);
    }
  };

  // 倒计时：每秒刷新一次
  useEffect(() => {
    if (!creds) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [creds]);

  const generate = async () => {
    setLoading(true);
    try {
      const res = await api.getTempCredentials(accountId);
      if (res.success) {
        setCreds(res.data);
        setNow(Date.now());
        // 存入 sessionStorage：切页面/刷新后仍能在有效期内恢复（关标签页清除）
        try { sessionStorage.setItem(`awstool:tempCreds:${accountId}`, JSON.stringify(res.data)); } catch { /* ignore */ }
        message.success('已生成 Admin 临时凭证（有效期约 1 小时）');
      } else {
        message.error(res.error || '生成失败');
      }
    } catch (e: any) {
      message.error(e.message || '生成失败');
    } finally {
      setLoading(false);
    }
  };

  const remainMs = creds ? new Date(creds.expiration).getTime() - now : 0;
  const expired = remainMs <= 0;
  const remainText = useMemo(() => {
    if (!creds || remainMs <= 0) return '已过期';
    const total = Math.floor(remainMs / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }, [creds, remainMs]);

  const envText = creds
    ? [
        `export AWS_ACCESS_KEY_ID=${creds.accessKeyId}`,
        `export AWS_SECRET_ACCESS_KEY=${creds.secretAccessKey}`,
        `export AWS_SESSION_TOKEN=${creds.sessionToken}`,
        `export AWS_DEFAULT_REGION=${creds.region}`,
      ].join('\n')
    : '';

  return (
    <div>
      {/* 根用户凭证状态 + 刷新 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap', rowGap: 4 }}>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>
          {(fetchedStatus || rootCredentials)
            ? (status.liveStatus ? 'MFA / 密钥为实时状态，密码等来自凭证报告' : '状态来自凭证报告（AWS 缓存，最长约 4 小时）')
            : ''}
        </span>
        <Tooltip title="重新读取根用户实时状态">
          <Button size="small" type="text" icon={<ReloadOutlined />} loading={statusLoading} onClick={refreshStatus}>刷新状态</Button>
        </Tooltip>
      </div>
      {(fetchedStatus || rootCredentials) ? (
        <Descriptions size="small" column={1} bordered layout={isMobile ? 'vertical' : 'horizontal'}>
          <Descriptions.Item label="密码">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', rowGap: 6 }}>
              <Tag color={status.passwordEnabled == null ? 'default' : (status.passwordEnabled ? 'green' : 'default')}>{status.passwordEnabled == null ? '未知' : (status.passwordEnabled ? '已启用' : '未启用')}</Tag>
              {canRoot && (
                <Popconfirm
                  title="允许恢复根用户密码"
                  description="将删除该账户根用户现有密码，使其可通过根邮箱自助重置。之后请到该账户登录页点「忘记密码」，用根邮箱收邮件设置新密码。操作会被审计。"
                  okText="确认删除密码" cancelText="取消"
                  onConfirm={handleRecoverPassword}
                >
                  <Button size="small" type="link" icon={<UnlockOutlined />} loading={pwdLoading}>允许恢复密码</Button>
                </Popconfirm>
              )}
            </div>
          </Descriptions.Item>
          <Descriptions.Item label="Root MFA">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', rowGap: 6 }}>
              <Tag color={status.mfaActive == null ? 'default' : (status.mfaActive ? 'green' : 'red')}>{status.mfaActive == null ? '未知' : (status.mfaActive ? '已启用' : '未启用 ⚠️')}</Tag>
              {canRoot && status.mfaActive === true && (
                <Popconfirm
                  title="删除根用户 MFA"
                  description="将停用并删除该账户根用户的虚拟 MFA 设备，此操作不可逆且会被审计。"
                  okText="删除" okType="danger" cancelText="取消"
                  onConfirm={handleDeleteMfa}
                >
                  <Button size="small" danger type="link" icon={<DeleteOutlined />} loading={mfaLoading}>删除</Button>
                </Popconfirm>
              )}
            </div>
          </Descriptions.Item>
          {Array.isArray(status.accessKeys) ? (
            <Descriptions.Item label="Access Keys">
              {status.accessKeys.length === 0 ? (
                <Tag color="green">无</Tag>
              ) : (
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  {status.accessKeys.map((k: any) => (
                    <div key={k.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, flexWrap: 'wrap', rowGap: 4 }}>
                      <Tag color={k.status === 'Active' ? 'red' : 'default'} style={{ margin: 0 }}>{k.status === 'Active' ? '存在 ⚠️' : k.status}</Tag>
                      <code style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k.id}</code>
                      {k.createDate && <span style={{ color: '#94a3b8', flexShrink: 0 }}>{new Date(k.createDate).toLocaleDateString()}</span>}
                      {canRoot && (
                        <Popconfirm
                          title="删除该访问密钥"
                          description={`将永久删除根用户访问密钥 ${k.id}，不可恢复。`}
                          okText="删除" okType="danger" cancelText="取消"
                          onConfirm={() => handleDeleteAccessKey(k.id)}
                        >
                          <Button size="small" danger type="link" aria-label={`删除访问密钥 ${k.id}`} icon={<DeleteOutlined />} loading={deletingKey === k.id} style={{ padding: '0 4px', flexShrink: 0 }} />
                        </Popconfirm>
                      )}
                    </div>
                  ))}
                </Space>
              )}
            </Descriptions.Item>
          ) : (
            <>
              <Descriptions.Item label="Access Key 1"><Tag color={status.accessKey1Active ? 'red' : 'green'}>{status.accessKey1Active ? '存在 ⚠️' : '无'}</Tag></Descriptions.Item>
              <Descriptions.Item label="Access Key 2"><Tag color={status.accessKey2Active ? 'red' : 'green'}>{status.accessKey2Active ? '存在 ⚠️' : '无'}</Tag></Descriptions.Item>
            </>
          )}
          {status.passwordLastUsed && <Descriptions.Item label="密码最后使用">{status.passwordLastUsed}</Descriptions.Item>}
        </Descriptions>
      ) : detailLoading ? <span style={{ color: '#999', fontSize: 12 }}>正在加载根用户状态…</span> : <span style={{ color: '#999', fontSize: 12 }}>根用户凭证状态不可用（凭证报告获取失败）</span>}

      {canRoot && (
        <>
      <Divider style={{ margin: '12px 0' }} />

      {/* Admin 临时凭证 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', rowGap: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          <SafetyCertificateOutlined style={{ marginRight: 6, color: '#1677ff' }} />Admin 临时凭证
        </span>
        <Space size={4}>
          {creds && (
            <Tooltip title={reveal ? '隐藏明文' : '显示明文'}>
              <Button size="small" type="text" aria-label={reveal ? '隐藏明文' : '显示明文'} icon={reveal ? <EyeInvisibleOutlined /> : <EyeOutlined />} onClick={() => setReveal(r => !r)} />
            </Tooltip>
          )}
          <Button
            size="small"
            type={creds ? 'default' : 'primary'}
            icon={creds ? <ReloadOutlined /> : <KeyOutlined />}
            loading={loading}
            onClick={generate}
          >
            {creds ? '刷新' : '生成 (1小时)'}
          </Button>
        </Space>
      </div>

      {creds ? (
        <div>
          <div style={{ marginBottom: 8 }}>
            <Tag color={expired ? 'red' : 'blue'}>{expired ? '已过期，请刷新' : `剩余有效期 ${remainText}`}</Tag>
            {!expired && <Tag>到期 {new Date(creds.expiration).toLocaleTimeString()}</Tag>}
            <Tag>{creds.region}</Tag>
          </div>
          <CredRow label="Access Key ID" value={creds.accessKeyId} reveal={reveal} />
          <CredRow label="Secret Access Key" value={creds.secretAccessKey} secret reveal={reveal} />
          <CredRow label="Session Token" value={creds.sessionToken} secret reveal={reveal} />
          <Button size="small" block icon={<CopyOutlined />} style={{ marginTop: 6 }} onClick={() => copy(envText, '环境变量')}>
            复制为环境变量 (export ...)
          </Button>
          <Alert
            style={{ marginTop: 8 }}
            type="warning"
            showIcon
            message="完整管理员权限凭证，请勿泄露。有效期约 1 小时，过期后点『刷新』重新生成。"
          />
        </div>
      ) : (
        <p style={{ color: '#999', fontSize: 12, margin: 0 }}>点击生成后可复制到 AWS CLI / SDK 使用（AdministratorAccess，有效期 1 小时）。</p>
      )}
        </>
      )}
    </div>
  );
};

export default RootCredentialsPanel;
