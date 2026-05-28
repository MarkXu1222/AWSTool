import React, { useState } from 'react';
import { Modal, Input, Alert, Tag } from 'antd';

interface Props {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmText: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

const DangerConfirm: React.FC<Props> = ({ open, title, description, confirmText, onConfirm, onCancel, loading }) => {
  const [input, setInput] = useState('');
  const match = input === confirmText;

  return (
    <Modal open={open} title={title} onCancel={() => { setInput(''); onCancel(); }}
      onOk={() => { if (match) { setInput(''); onConfirm(); } }}
      okButtonProps={{ danger: true, disabled: !match, loading }} okText="确认执行" cancelText="取消">
      <Alert message="⚠️ 此操作不可逆" type="error" showIcon style={{ marginBottom: 12 }} />
      {description}
      <p>请输入 <Tag color="red">{confirmText}</Tag> 以确认：</p>
      <Input value={input} onChange={e => setInput(e.target.value)} placeholder={confirmText} size="large" />
    </Modal>
  );
};

export default DangerConfirm;
