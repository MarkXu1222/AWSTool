import React, { useEffect, useState } from 'react';
import { Alert, Input, Modal, Radio, Space, Typography, message } from 'antd';
import { api } from '../api';

/**
 * 临时开通 Admin：针对没有 OrganizationAccountAccessRole 的成员账户，经 payer 部署 admin-console
 * （AdministratorAccess），1–3 小时后由平台自动删除。仅 admin 可用，需 TOTP 二次验证。
 * 服务端会实测 OAAR：能经 OAAR 进入的账户直接拒绝。
 */
const TempAdminModal: React.FC<{
  open: boolean;
  account: { Id: string; Name?: string } | null;
  onClose: () => void;
  onOpened: (grant: any) => void;
}> = ({ open, account, onClose, onOpened }) => {
  const [hours, setHours] = useState(2);
  const [mfaCode, setMfaCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { if (open) { setHours(2); setMfaCode(''); } }, [open, account?.Id]);

  const submit = async () => {
    if (!account) return;
    if (!/^\d{6}$/.test(mfaCode)) { message.warning('请输入 6 位 MFA 验证码'); return; }
    setSubmitting(true);
    try {
      const res = await api.openTempAdmin({ accountId: account.Id, hours, mfaCode });
      if (res.success) {
        const until = res.data?.expiresAt ? new Date(res.data.expiresAt).toLocaleString() : '';
        message.success(`临时 Admin 已开通，到期 ${until}`);
        onOpened(res.data);
        onClose();
      } else {
        message.error(res.error || '开通失败');
      }
    } catch (e: any) {
      message.error(e.message || '开通失败');
    } finally { setSubmitting(false); }
  };

  return (
    <Modal
      title={`临时开通 Admin${account ? ` — ${account.Name || account.Id}` : ''}`}
      open={open}
      onCancel={() => { if (!submitting) onClose(); }}
      onOk={submit}
      okText="开通"
      okButtonProps={{ danger: true, disabled: !/^\d{6}$/.test(mfaCode) }}
      confirmLoading={submitting}
      maskClosable={!submitting}
      closable={!submitting}
    >
      <Alert type="warning" showIcon style={{ marginBottom: 16 }}
        message="将通过 payer 对该账户临时部署 admin-console（AdministratorAccess），到期自动删除。仅适用于没有 OrganizationAccountAccessRole 的账户，部署约需 1–5 分钟。" />
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div>
          <Typography.Text style={{ display: 'block', marginBottom: 6 }}>开通时长</Typography.Text>
          <Radio.Group value={hours} onChange={e => setHours(e.target.value)} disabled={submitting}
            options={[1, 2, 3].map(h => ({ label: `${h} 小时`, value: h }))} optionType="button" />
        </div>
        <div>
          <Typography.Text style={{ display: 'block', marginBottom: 6 }}>MFA 验证码</Typography.Text>
          <Input value={mfaCode} onChange={e => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric" maxLength={6} placeholder="6 位验证码" style={{ width: 160 }}
            aria-label="MFA 验证码" disabled={submitting} onPressEnter={submit} />
        </div>
        {submitting && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            正在部署并复验 admin-console，请勿关闭页面
          </Typography.Text>
        )}
      </Space>
    </Modal>
  );
};

export default TempAdminModal;
