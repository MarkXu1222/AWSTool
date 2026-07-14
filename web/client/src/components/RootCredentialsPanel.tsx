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
      <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => copy(value, label)} />
    </Tooltip>
  </div>
);

const RootCredentialsPanel: React.FC<Props> = ({ accountId, rootCredentials, canRoot }) => {
  const [creds, setCreds] = useState<TempCreds | null>(null);
  const [loading, setLoading] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [mfaLoading, setMfaLoading] = useState(false);
  const [pwdLoading, setPwdLoading] = useState(false);
  // 操作成功后对根用户状态做本地覆盖（无需等待父组件重新拉取）
  const [statusOverride, setStatusOverride] = useState<Record<string, any>>({});

  // 切换账户时清空已生成的凭证与本地覆盖
  useEffect(() => { setCreds(null); setReveal(false); setStatusOverride({}); }, [accountId]);

  const status = { ...rootCredentials, ...statusOverride };

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
        message.success('已触发根用户密码恢复（重置邮件将发送至该账户根邮箱）');
      } else {
        message.error(res.error || '恢复失败');
      }
    } catch (e: any) {
      message.error(e.message || '恢复失败');
    } finally {
      setPwdLoading(false);
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
      {/* 根用户凭证只读状态 */}
      {rootCredentials ? (
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="密码">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <Tag color={status.passwordEnabled ? 'green' : 'default'}>{status.passwordEnabled ? '已启用' : '未启用'}</Tag>
              {canRoot && (
                <Popconfirm
                  title="恢复根用户密码"
                  description="将为该账户根用户触发密码恢复流程（AWS 向该账户根邮箱发送重置邮件）。操作会被审计。"
                  okText="恢复" cancelText="取消"
                  onConfirm={handleRecoverPassword}
                >
                  <Button size="small" type="link" icon={<UnlockOutlined />} loading={pwdLoading}>恢复密码</Button>
                </Popconfirm>
              )}
            </div>
          </Descriptions.Item>
          <Descriptions.Item label="Root MFA">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <Tag color={status.mfaActive ? 'green' : 'red'}>{status.mfaActive ? '已启用' : '未启用 ⚠️'}</Tag>
              {canRoot && status.mfaActive && (
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
          <Descriptions.Item label="Access Key 1"><Tag color={status.accessKey1Active ? 'red' : 'green'}>{status.accessKey1Active ? '存在 ⚠️' : '无'}</Tag></Descriptions.Item>
          <Descriptions.Item label="Access Key 2"><Tag color={status.accessKey2Active ? 'red' : 'green'}>{status.accessKey2Active ? '存在 ⚠️' : '无'}</Tag></Descriptions.Item>
          <Descriptions.Item label="密码最后使用">{status.passwordLastUsed || '-'}</Descriptions.Item>
        </Descriptions>
      ) : <span style={{ color: '#999', fontSize: 12 }}>根用户凭证状态不可用（凭证报告获取失败）</span>}

      {canRoot && (
        <>
      <Divider style={{ margin: '12px 0' }} />

      {/* Admin 临时凭证 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          <SafetyCertificateOutlined style={{ marginRight: 6, color: '#1677ff' }} />Admin 临时凭证
        </span>
        <Space size={4}>
          {creds && (
            <Tooltip title={reveal ? '隐藏明文' : '显示明文'}>
              <Button size="small" type="text" icon={reveal ? <EyeInvisibleOutlined /> : <EyeOutlined />} onClick={() => setReveal(r => !r)} />
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
